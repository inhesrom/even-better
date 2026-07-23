import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  readableValue,
  terminalSummary,
  type JsonRecord,
  type NormalizedPromptResponse,
  type NormalizedQuestion,
  type NormalizedQuestionRequest,
  type NormalizedToolPatch,
  type NormalizedUpdate,
  type TerminalUsage,
} from "./grok-acp-normalize.js";
import {
  GrokAcpProcess,
  type GrokProcessEvent,
  type PermissionDecision,
} from "./grok-acp-process.js";
import type { GrokConfig } from "./grok-config.js";
import { OutputStream } from "./output-stream.js";
import { renderForGlasses } from "./render.js";
import { SessionControlError, type LiveSession, type SessionDescriptor, type SessionState } from "./session.js";
import { emit } from "./sse.js";

const STREAM_TICK_MS = (() => {
  const raw = Number(process.env.STREAM_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 140;
})();

interface ToolState {
  id: string;
  publicId: string;
  title: string;
  kind: string;
  status: string;
  input: unknown;
  contentOutput: string;
  rawOutput: string;
  displayName: string;
  summary: string;
  started: boolean;
  ended: boolean;
}

interface PermissionInteraction {
  type: "permission";
  id: string;
  toolName: string;
  options: Array<{ key: PermissionDecision; label: string }>;
}

interface QuestionInteraction {
  type: "question";
  id: string;
  request: NormalizedQuestionRequest;
  index: number;
  answers: Record<string, string[]>;
  annotations: Record<string, { preview?: string; notes?: string }>;
}

type Interaction = PermissionInteraction | QuestionInteraction;

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { value: input };
}

function positiveDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

export class GrokSessionBridge implements LiveSession {
  readonly id = `grok:${randomUUID()}`;
  readonly provider = "grok" as const;
  readonly cwd: string;
  state: SessionState = "idle";

  private readonly process: GrokAcpProcess;
  private readonly out: OutputStream;
  private unsubscribe: (() => void) | null = null;
  private model = "Unknown";
  private startedAt = new Date().toISOString();
  private available = false;
  private disposed = false;
  private turnStartedMs = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private proseBuffer = "";
  private lastProseBlock = "";
  private unsupportedNotified = false;
  private tools = new Map<string, ToolState>();
  private interaction: Interaction | null = null;
  private previousUsage: TerminalUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  private turnUsage: TerminalUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  private terminalizing = false;

  constructor(config: GrokConfig) {
    this.cwd = config.cwd;
    this.process = new GrokAcpProcess(config);
    this.out = new OutputStream((message) => emit(this.id, message), STREAM_TICK_MS);
    this.unsubscribe = this.process.onEvent((event) => this.onProcessEvent(event));
  }

  async start(): Promise<void> {
    const info = await this.process.start();
    this.model = info.model;
    this.available = true;
  }

  async describe(): Promise<SessionDescriptor> {
    return {
      id: this.id,
      title: `grok · ${path.basename(this.cwd || "/")}`,
      timestamp: this.startedAt,
      cwd: this.cwd,
      provider: this.provider,
      status: this.state,
      model: this.model,
    };
  }

  async prompt(text: string): Promise<void> {
    if (!this.available) throw new SessionControlError("Grok session ended; restart even-better.", 503);
    if (this.state !== "idle" || this.terminalizing) {
      throw new SessionControlError("Grok is already processing a prompt.", 409);
    }
    this.beginTurn();
    emit(this.id, { type: "user_prompt", text });
    emit(this.id, { type: "status", state: "busy", sessionId: this.id });
    try {
      await this.process.prompt(text);
    } catch (error) {
      await this.finishFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async respondPermission(decision: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "permission") {
      throw new SessionControlError("No matching Grok permission request.", 409);
    }
    const normalized: PermissionDecision | null =
      decision === "allowAlways" ? "allowAlways" : decision === "allow" ? "allow" : decision === "deny" ? "deny" : null;
    if (!normalized || !pending.options.some((option) => option.key === normalized)) {
      throw new SessionControlError("That permission choice was not offered by Grok.", 409);
    }
    try {
      const label = await this.process.respondPermission(pending.id, normalized);
      this.interaction = null;
      this.state = "busy";
      emit(this.id, {
        type: "permission_result",
        toolName: pending.toolName,
        summary: label,
        decision: normalized === "allowAlways" ? "always" : normalized === "allow" ? "allowed" : "denied",
      });
    } catch (error) {
      throw new SessionControlError("Could not send the response to Grok.", 502);
    }
  }

  async respondQuestion(answer: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "question") {
      throw new SessionControlError("No matching Grok question.", 409);
    }
    const question = pending.request.questions[pending.index];
    const parsed = this.normalizeAnswer(question, answer);
    pending.answers[question.question] = parsed.labels;
    if (parsed.annotation) pending.annotations[question.question] = parsed.annotation;
    emit(this.id, { type: "question_answer", answers: { answer: parsed.display } });
    pending.index++;
    if (pending.index < pending.request.questions.length) {
      this.emitCurrentQuestion(pending);
      return;
    }
    const response: JsonRecord = {
      outcome: "accepted",
      answers: pending.answers,
      ...(Object.keys(pending.annotations).length ? { annotations: pending.annotations } : {}),
    };
    try {
      await this.process.respondQuestion(pending.id, response);
      this.interaction = null;
      this.state = "busy";
    } catch {
      throw new SessionControlError("Could not send the response to Grok.", 502);
    }
  }

  async interrupt(): Promise<void> {
    if (this.state === "idle" || this.terminalizing) return;
    this.interaction = null;
    this.state = "busy";
    try {
      await this.process.cancel();
    } catch {
      throw new SessionControlError("Could not interrupt Grok.", 502);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopStats();
    this.out.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.process.dispose();
  }

  private beginTurn(): void {
    this.turnStartedMs = Date.now();
    this.state = "busy";
    this.proseBuffer = "";
    this.lastProseBlock = "";
    this.unsupportedNotified = false;
    this.tools.clear();
    this.interaction = null;
    this.turnUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    this.terminalizing = false;
    this.startStats();
  }

  private onProcessEvent(event: GrokProcessEvent): void {
    switch (event.type) {
      case "update":
        this.onUpdate(event.update);
        break;
      case "permission":
        this.flushProse();
        this.state = "awaiting";
        this.interaction = {
          type: "permission",
          id: event.interactionId,
          toolName: event.toolName,
          options: event.options,
        };
        this.out.event({
          type: "permission_request",
          toolName: event.toolName,
          description: event.description,
          detail: event.description,
          toolUseId: this.tools.get(event.toolId)?.publicId ?? `grok-tool:${randomUUID()}`,
          options: event.options.map((option) => ({ text: option.label, key: option.key })),
          suggestions: [],
        });
        break;
      case "question": {
        this.flushProse();
        this.state = "awaiting";
        const pending: QuestionInteraction = {
          type: "question",
          id: event.interactionId,
          request: event.request,
          index: 0,
          answers: {},
          annotations: {},
        };
        this.interaction = pending;
        this.emitCurrentQuestion(pending);
        break;
      }
      case "terminal":
        void this.finishTerminal(event.response, event.usage, event.cancellationCategory);
        break;
      case "prompt_error":
        void this.finishFailure(event.message);
        break;
      case "fatal":
        this.available = false;
        if (this.state === "idle") {
          emit(this.id, { type: "notification", title: "Grok session ended", message: event.message });
        } else {
          void this.finishFailure(event.message);
        }
        break;
    }
  }

  private onUpdate(update: NormalizedUpdate): void {
    switch (update.kind) {
      case "user":
      case "thought":
      case "usage_context":
      case "metadata":
        break;
      case "prose":
        this.proseBuffer += update.text;
        this.flushCompleteParagraphs();
        break;
      case "unsupported_content":
        if (!this.unsupportedNotified) {
          this.unsupportedNotified = true;
          this.flushProse();
          this.out.event({
            type: "notification",
            title: "Unsupported Grok content",
            message: `The response included ${update.contentType} content that cannot be shown on the glasses.`,
          });
        }
        break;
      case "tool":
        this.flushProse();
        this.applyTool(update.patch);
        break;
      case "plan": {
        this.flushProse();
        const completed = update.entries.filter((entry) => entry.status === "completed").length;
        const current =
          update.entries.find((entry) => entry.status === "in_progress")?.content
          ?? (completed === update.entries.length && update.entries.length ? "All done" : update.entries.find((entry) => entry.status === "pending")?.content ?? "");
        this.out.event({ type: "task_progress", completed, total: update.entries.length, current });
        break;
      }
    }
  }

  private applyTool(patch: NormalizedToolPatch): void {
    const tool = this.tools.get(patch.id) ?? {
      id: patch.id,
      publicId: `grok-tool:${randomUUID()}`,
      title: "Grok tool",
      kind: "",
      status: "pending",
      input: {},
      contentOutput: "",
      rawOutput: "",
      displayName: "Grok tool",
      summary: "",
      started: false,
      ended: false,
    };
    if (patch.present.includes("title")) tool.title = patch.title?.trim() ?? "";
    if (patch.present.includes("kind")) tool.kind = patch.kind ?? "";
    if (patch.present.includes("status")) tool.status = patch.status ?? "";
    if (patch.present.includes("rawInput")) tool.input = patch.rawInput;
    if (patch.present.includes("rawOutput")) tool.rawOutput = readableValue(patch.rawOutput);
    if (patch.present.includes("content")) tool.contentOutput = patch.content ?? "";
    this.tools.set(tool.id, tool);
    if (!tool.started) {
      tool.started = true;
      tool.displayName = tool.title || tool.kind || "Grok tool";
      tool.summary = tool.title;
      this.out.event({
        type: "tool_start",
        name: tool.displayName,
        toolId: tool.publicId,
        summary: tool.summary,
        detail: { input: inputObject(tool.input) },
      });
    }
    if (!tool.ended && (tool.status === "completed" || tool.status === "failed")) {
      this.endTool(
        tool,
        tool.rawOutput || tool.contentOutput || (tool.status === "completed" ? "Completed." : "Failed."),
      );
    }
  }

  private endTool(tool: ToolState, output: string): void {
    if (tool.ended) return;
    tool.ended = true;
    this.out.event({
      type: "tool_end",
      name: tool.displayName,
      toolId: tool.publicId,
      summary: tool.summary,
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

  private emitCurrentQuestion(pending: QuestionInteraction): void {
    const question = pending.request.questions[pending.index];
    const total = pending.request.questions.length;
    this.out.event({
      type: "user_question",
      questions: [
        {
          question: question.question,
          header: total === 1 ? "Grok" : `Question ${pending.index + 1} of ${total}`,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
            ...(option.preview ? { preview: option.preview } : {}),
          })),
        },
      ],
      toolUseId: `${pending.id}:${pending.index}`,
    });
  }

  private normalizeAnswer(
    question: NormalizedQuestion,
    answer: string,
  ): { labels: string[]; display: string; annotation?: { preview?: string; notes?: string } } {
    let submitted: string[] = [answer];
    let display = answer;
    try {
      const parsed = JSON.parse(answer) as unknown;
      const value =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? Object.values(parsed as Record<string, unknown>)[0]
          : parsed;
      if (typeof value === "string") {
        submitted = [value];
        display = value;
      } else if (
        question.multiSelect
        && Array.isArray(value)
        && value.length > 0
        && value.every((item) => typeof item === "string")
      ) {
        submitted = value as string[];
        display = submitted.join(", ");
      }
    } catch {
      // Plain labels and free text remain one answer.
    }
    const matches = submitted.map((value) =>
      question.options.find((option) => option.label.toLowerCase() === value.trim().toLowerCase()),
    );
    if (matches.length > 0 && matches.every((value) => value !== undefined)) {
      const labels = matches.map((value) => value!.label);
      const preview = matches.length === 1 ? matches[0]?.preview : undefined;
      return {
        labels,
        display: labels.join(", "),
        ...(preview ? { annotation: { preview } } : {}),
      };
    }
    return { labels: ["Other"], display, annotation: { notes: display } };
  }

  private async finishTerminal(
    response: NormalizedPromptResponse,
    usage: TerminalUsage | undefined,
    cancellationCategory: string | undefined,
  ): Promise<void> {
    if (this.terminalizing || this.state === "idle") return;
    this.terminalizing = true;
    if (usage) {
      if (usage.cumulative === false) {
        this.turnUsage = usage;
        this.previousUsage = {
          inputTokens: this.previousUsage.inputTokens + usage.inputTokens,
          outputTokens: this.previousUsage.outputTokens + usage.outputTokens,
          turns: this.previousUsage.turns + usage.turns,
        };
      } else {
        this.turnUsage = {
          inputTokens: positiveDelta(usage.inputTokens, this.previousUsage.inputTokens),
          outputTokens: positiveDelta(usage.outputTokens, this.previousUsage.outputTokens),
          turns: positiveDelta(usage.turns, this.previousUsage.turns),
        };
        this.previousUsage = usage;
      }
    }
    const summary = terminalSummary(response.stopReason, cancellationCategory);
    await this.finishTurn(summary.success, summary.fallback, response.stopReason === "cancelled");
  }

  private finishFailure(message: string): Promise<void> {
    if (this.terminalizing || this.state === "idle") return Promise.resolve();
    this.terminalizing = true;
    return this.finishTurn(false, message || "Grok could not complete the turn.", false);
  }

  private async finishTurn(success: boolean, fallback: string, cancelled: boolean): Promise<void> {
    this.interaction = null;
    for (const tool of this.tools.values()) {
      if (!tool.ended) {
        this.endTool(tool, cancelled ? "Cancelled." : "Grok ended before reporting this tool's result.");
      }
    }
    this.flushProse();
    await this.out.drain();
    this.stopStats();
    emit(this.id, {
      type: "result",
      success,
      text: renderForGlasses(success && this.lastProseBlock ? this.lastProseBlock : fallback),
      sessionId: this.id,
      costUsd: 0,
      provider: this.provider,
      turns: this.turnUsage.turns,
      durationMs: this.turnStartedMs ? Date.now() - this.turnStartedMs : 0,
      inputTokens: this.turnUsage.inputTokens,
      outputTokens: this.turnUsage.outputTokens,
    });
    this.state = "idle";
    this.turnStartedMs = 0;
    emit(this.id, { type: "status", state: "idle", sessionId: this.id });
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
