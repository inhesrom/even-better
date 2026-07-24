import { randomUUID } from "node:crypto";
import type {
  OwnedAgent,
  OwnedAgentEvent,
  OwnedAgentSink,
  OwnedAgentStartInfo,
  OwnedPermissionDecision,
  OwnedUsage,
} from "./owned-agent.js";
import { OutputStream } from "./output-stream.js";
import { renderForGlasses } from "./render.js";
import { SessionControlError, type SessionState } from "./session.js";
import { emit } from "./sse.js";

const STREAM_TICK_MS = (() => {
  const raw = Number(process.env.STREAM_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 140;
})();

interface ToolState {
  publicId: string;
  name: string;
  input: unknown;
  output: string;
  ended: boolean;
}

type Interaction =
  | { type: "permission"; toolName: string; options: OwnedPermissionDecision[] }
  | { type: "question" };

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { value: input };
}

function providerName(provider: OwnedAgent["provider"]): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok";
}

export interface OwnedSessionBridgeHooks {
  model?(model: string): void;
  assistant?(text: string): void;
  activity?(): void;
  unavailable?(): void;
}

/** Provider-neutral owner of public ids, wire events, pacing, and turn state. */
export class OwnedSessionBridge implements OwnedAgentSink {
  readonly provider = "codex" as const;
  readonly agentProvider: OwnedAgent["provider"];
  readonly cwd: string;
  state: SessionState = "idle";

  private readonly out: OutputStream;
  private model = "Unknown";
  private available = false;
  private disposed = false;
  private terminalizing = false;
  private turnStartedMs = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private proseBuffer = "";
  private lastProseBlock = "";
  private tools = new Map<string, ToolState>();
  private interaction: Interaction | null = null;
  private pendingWire: object | null = null;
  private turnUsage: OwnedUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  private assistantHistory = "";

  constructor(
    readonly id: string,
    private readonly agent: OwnedAgent,
    private readonly hooks: OwnedSessionBridgeHooks = {},
  ) {
    this.agentProvider = agent.provider;
    this.cwd = agent.cwd;
    this.out = new OutputStream((message) => emit(this.id, message), STREAM_TICK_MS);
  }

  async start(nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    const info = await this.agent.start(this, nativeSessionId);
    this.model = info.model || this.model;
    this.available = true;
    return info;
  }

  async prompt(text: string): Promise<void> {
    if (!this.available) {
      throw new SessionControlError(`${providerName(this.agentProvider)} session is detached; reopen it and retry.`, 503);
    }
    if (this.state !== "idle" || this.terminalizing) {
      throw new SessionControlError(`${providerName(this.agentProvider)} is already processing a prompt.`, 409);
    }
    this.beginTurn();
    emit(this.id, { type: "user_prompt", text });
    emit(this.id, { type: "status", state: "busy", sessionId: this.id, provider: "codex", agentProvider: this.agentProvider });
    try {
      await this.agent.prompt(text);
    } catch (error) {
      await this.finishFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async respondPermission(decision: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "permission") {
      throw new SessionControlError(`No matching ${providerName(this.agentProvider)} permission request.`, 409);
    }
    const normalized: OwnedPermissionDecision | null =
      decision === "allowAlways" ? "allowAlways" : decision === "allow" ? "allow" : decision === "deny" ? "deny" : null;
    if (!normalized || !pending.options.includes(normalized)) {
      throw new SessionControlError(`That permission choice was not offered by ${providerName(this.agentProvider)}.`, 409);
    }
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    try {
      await this.agent.respondPermission(normalized);
      emit(this.id, {
        type: "permission_result",
        toolName: pending.toolName,
        summary: normalized === "allowAlways" ? "Allowed for this session" : normalized === "allow" ? "Allowed" : "Denied",
        decision: normalized === "allowAlways" ? "always" : normalized === "allow" ? "allowed" : "denied",
      });
    } catch {
      throw new SessionControlError(`Could not send the response to ${providerName(this.agentProvider)}.`, 502);
    }
  }

  async respondQuestion(answer: string): Promise<void> {
    if (!this.interaction || this.interaction.type !== "question") {
      throw new SessionControlError(`No matching ${providerName(this.agentProvider)} question.`, 409);
    }
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    emit(this.id, { type: "question_answer", answers: { answer } });
    try {
      await this.agent.respondQuestion(answer);
    } catch {
      throw new SessionControlError(`Could not send the response to ${providerName(this.agentProvider)}.`, 502);
    }
  }

  async interrupt(): Promise<void> {
    if (this.state === "idle" || this.terminalizing) return;
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    try {
      await this.agent.interrupt();
    } catch {
      throw new SessionControlError(`Could not interrupt ${providerName(this.agentProvider)}.`, 502);
    }
  }

  replayPending(): void {
    if (this.pendingWire) emit(this.id, this.pendingWire);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.available = false;
    this.stopStats();
    this.out.clear();
    if (this.state !== "idle") {
      try {
        await this.agent.interrupt();
      } catch {
        // Disposal continues to process teardown even if cancellation failed.
      }
    }
    await this.agent.dispose();
  }

  event(event: OwnedAgentEvent): void {
    switch (event.type) {
      case "model":
        this.model = event.model || "Unknown";
        this.hooks.model?.(this.model);
        break;
      case "prose":
        this.assistantHistory += event.text;
        this.proseBuffer += event.text;
        this.flushCompleteParagraphs();
        break;
      case "tool":
        this.flushProse();
        this.applyTool(event);
        break;
      case "plan": {
        this.flushProse();
        const completed = event.entries.filter((entry) => entry.status === "completed").length;
        const current = event.entries.find((entry) => entry.status === "in_progress")?.content
          ?? (completed === event.entries.length && event.entries.length
            ? "All done"
            : event.entries.find((entry) => entry.status === "pending")?.content ?? "");
        this.out.event({ type: "task_progress", completed, total: event.entries.length, current });
        break;
      }
      case "usage":
        this.turnUsage = event.usage;
        break;
      case "permission": {
        this.flushProse();
        this.state = "awaiting";
        this.interaction = {
          type: "permission",
          toolName: event.toolName,
          options: event.options.map((option) => option.key),
        };
        const wire = {
          type: "permission_request",
          toolName: event.toolName,
          description: event.description,
          detail: event.description,
          toolUseId: this.tools.get(event.toolId)?.publicId ?? `owned-tool:${randomUUID()}`,
          options: event.options.map((option) => ({ text: option.label, key: option.key })),
          suggestions: [],
        };
        this.pendingWire = wire;
        this.out.event(wire);
        break;
      }
      case "question": {
        this.flushProse();
        this.state = "awaiting";
        this.interaction = { type: "question" };
        const wire = {
          type: "user_question",
          questions: [{
            question: event.question.question,
            header: event.total === 1 ? providerName(this.agentProvider) : `Question ${event.index + 1} of ${event.total}`,
            options: event.question.options,
          }],
          toolUseId: `owned-question:${randomUUID()}`,
        };
        this.pendingWire = wire;
        this.out.event(wire);
        break;
      }
      case "result":
        if (event.usage) this.turnUsage = event.usage;
        void this.finishTurn(
          event.success,
          event.text || (event.cancelled ? "Interrupted." : `${providerName(this.agentProvider)} could not complete the turn.`),
          event.cancelled ?? false,
          event.costUsd ?? 0,
        );
        break;
      case "notification":
        this.flushProse();
        this.out.event({ type: "notification", title: event.title, message: event.message });
        break;
      case "fatal":
        this.available = false;
        if (this.state === "idle") {
          emit(this.id, { type: "notification", title: `${providerName(this.agentProvider)} session ended`, message: event.message });
          this.hooks.unavailable?.();
        } else {
          void this.finishFailure(event.message).finally(() => this.hooks.unavailable?.());
        }
        break;
    }
  }

  private beginTurn(): void {
    this.turnStartedMs = Date.now();
    this.state = "busy";
    this.proseBuffer = "";
    this.lastProseBlock = "";
    this.tools.clear();
    this.interaction = null;
    this.pendingWire = null;
    this.turnUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    this.assistantHistory = "";
    this.terminalizing = false;
    this.startStats();
  }

  private applyTool(event: Extract<OwnedAgentEvent, { type: "tool" }>): void {
    let tool = this.tools.get(event.id);
    if (!tool) {
      tool = {
        publicId: `owned-tool:${randomUUID()}`,
        name: event.name || `${providerName(this.agentProvider)} tool`,
        input: event.input ?? {},
        output: event.output ?? "",
        ended: false,
      };
      this.tools.set(event.id, tool);
      this.out.event({
        type: "tool_start",
        name: tool.name,
        toolId: tool.publicId,
        summary: tool.name,
        detail: { input: inputObject(tool.input) },
      });
    }
    if (event.input !== undefined) tool.input = event.input;
    if (event.output !== undefined) tool.output = event.output;
    if (!tool.ended && (event.status === "completed" || event.status === "failed")) {
      this.endTool(tool, tool.output || (event.status === "completed" ? "Completed." : "Failed."));
    }
  }

  private endTool(tool: ToolState, output: string): void {
    if (tool.ended) return;
    tool.ended = true;
    this.out.event({
      type: "tool_end",
      name: tool.name,
      toolId: tool.publicId,
      summary: tool.name,
      detail: { input: inputObject(tool.input), output },
    });
  }

  private flushCompleteParagraphs(): void {
    for (;;) {
      const boundary = this.proseBuffer.indexOf("\n\n");
      if (boundary >= 0) {
        this.queueProse(this.proseBuffer.slice(0, boundary + 2));
        this.proseBuffer = this.proseBuffer.slice(boundary + 2);
        continue;
      }
      const codePoints = [...this.proseBuffer];
      if (codePoints.length <= 800 || /(^|\n)\s*\|.*\|/.test(this.proseBuffer)) return;
      let at = 800;
      for (let i = 799; i > 0; i--) {
        if (/\s/.test(codePoints[i])) {
          at = i + 1;
          break;
        }
      }
      this.queueProse(codePoints.slice(0, at).join(""));
      this.proseBuffer = codePoints.slice(at).join("");
    }
  }

  private flushProse(): void {
    if (!this.proseBuffer) return;
    this.queueProse(this.proseBuffer);
    this.proseBuffer = "";
  }

  private queueProse(text: string): void {
    if (!text) return;
    this.lastProseBlock = text.trim() || this.lastProseBlock;
    this.out.text(renderForGlasses(text));
  }

  private finishFailure(message: string): Promise<void> {
    if (this.terminalizing || this.state === "idle") return Promise.resolve();
    return this.finishTurn(false, message, false, 0);
  }

  private async finishTurn(success: boolean, fallback: string, cancelled: boolean, costUsd: number): Promise<void> {
    if (this.terminalizing || this.state === "idle") return;
    this.terminalizing = true;
    this.interaction = null;
    this.pendingWire = null;
    for (const tool of this.tools.values()) {
      if (!tool.ended) this.endTool(tool, cancelled ? "Cancelled." : `${providerName(this.agentProvider)} ended before reporting this tool's result.`);
    }
    this.flushProse();
    await this.out.drain();
    this.stopStats();
    const historyText = this.assistantHistory.trim() || (success ? fallback.trim() : "");
    if (historyText) this.hooks.assistant?.(historyText);
    emit(this.id, {
      type: "result",
      success,
      text: renderForGlasses(success && this.lastProseBlock ? this.lastProseBlock : fallback),
      sessionId: this.id,
      costUsd,
      provider: "codex",
      agentProvider: this.agentProvider,
      turns: this.turnUsage.turns,
      durationMs: this.turnStartedMs ? Date.now() - this.turnStartedMs : 0,
      inputTokens: this.turnUsage.inputTokens,
      outputTokens: this.turnUsage.outputTokens,
    });
    this.state = "idle";
    this.turnStartedMs = 0;
    emit(this.id, { type: "status", state: "idle", sessionId: this.id, provider: "codex", agentProvider: this.agentProvider });
    this.hooks.activity?.();
    this.terminalizing = false;
  }

  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      emit(this.id, {
        type: "running_stats",
        durationMs: this.turnStartedMs ? Date.now() - this.turnStartedMs : 0,
        inputTokens: this.turnUsage.inputTokens,
        outputTokens: this.turnUsage.outputTokens,
      });
    }, 10_000);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}
