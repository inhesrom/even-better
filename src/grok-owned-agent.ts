import {
  readableValue,
  terminalSummary,
  type JsonRecord,
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
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo, OwnedQuestion, OwnedUsage } from "./owned-agent.js";

interface PendingPermission {
  id: string;
  options: PermissionDecision[];
}

interface PendingQuestion {
  id: string;
  request: NormalizedQuestionRequest;
  index: number;
  answers: Record<string, string[]>;
  annotations: Record<string, { preview?: string; notes?: string }>;
}

function positiveDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

function usageValue(usage: TerminalUsage): OwnedUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    turns: usage.turns,
  };
}

/** Grok ACP normalized behind the source-neutral owned-agent contract. */
export class GrokOwnedAgent implements OwnedAgent {
  readonly provider = "grok" as const;
  readonly cwd: string;

  private readonly process: GrokAcpProcess;
  private sink: OwnedAgentSink | null = null;
  private unsubscribe: (() => void) | null = null;
  private permission: PendingPermission | null = null;
  private question: PendingQuestion | null = null;
  private previousUsage: TerminalUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };

  constructor(config: GrokConfig) {
    this.cwd = config.cwd;
    this.process = new GrokAcpProcess(config);
  }

  async start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    this.sink = sink;
    this.unsubscribe = this.process.onEvent((event) => this.onProcessEvent(event));
    const info = await this.process.start(nativeSessionId);
    sink.event({ type: "model", model: info.model });
    return { nativeSessionId: info.sessionId, model: info.model };
  }

  prompt(text: string): Promise<void> {
    return this.process.prompt(text);
  }

  async respondPermission(decision: string): Promise<void> {
    const pending = this.permission;
    const normalized: PermissionDecision | null =
      decision === "allowAlways" ? "allowAlways" : decision === "allow" ? "allow" : decision === "deny" ? "deny" : null;
    if (!pending || !normalized || !pending.options.includes(normalized)) throw new Error("No matching Grok permission.");
    await this.process.respondPermission(pending.id, normalized);
    this.permission = null;
  }

  async respondQuestion(answer: string): Promise<void> {
    const pending = this.question;
    if (!pending) throw new Error("No matching Grok question.");
    const question = pending.request.questions[pending.index];
    const parsed = this.normalizeAnswer(question, answer);
    pending.answers[question.question] = parsed.labels;
    if (parsed.annotation) pending.annotations[question.question] = parsed.annotation;
    pending.index++;
    if (pending.index < pending.request.questions.length) {
      this.emitQuestion(pending);
      return;
    }
    const response: JsonRecord = {
      outcome: "accepted",
      answers: pending.answers,
      ...(Object.keys(pending.annotations).length ? { annotations: pending.annotations } : {}),
    };
    await this.process.respondQuestion(pending.id, response);
    this.question = null;
  }

  interrupt(): Promise<void> {
    this.permission = null;
    this.question = null;
    return this.process.cancel();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.permission = null;
    this.question = null;
    await this.process.dispose();
  }

  private onProcessEvent(event: GrokProcessEvent): void {
    if (!this.sink) return;
    switch (event.type) {
      case "update":
        this.onUpdate(event.update);
        break;
      case "permission":
        this.permission = { id: event.interactionId, options: event.options.map((option) => option.key) };
        this.sink.event({
          type: "permission",
          id: event.interactionId,
          toolId: event.toolId,
          toolName: event.toolName,
          description: event.description,
          options: event.options,
        });
        break;
      case "question": {
        const pending: PendingQuestion = {
          id: event.interactionId,
          request: event.request,
          index: 0,
          answers: {},
          annotations: {},
        };
        this.question = pending;
        this.emitQuestion(pending);
        break;
      }
      case "terminal": {
        let usage: OwnedUsage | undefined;
        if (event.usage) {
          if (event.usage.cumulative === false) {
            usage = usageValue(event.usage);
            this.previousUsage = {
              inputTokens: this.previousUsage.inputTokens + event.usage.inputTokens,
              outputTokens: this.previousUsage.outputTokens + event.usage.outputTokens,
              turns: this.previousUsage.turns + event.usage.turns,
            };
          } else {
            usage = {
              inputTokens: positiveDelta(event.usage.inputTokens, this.previousUsage.inputTokens),
              outputTokens: positiveDelta(event.usage.outputTokens, this.previousUsage.outputTokens),
              turns: positiveDelta(event.usage.turns, this.previousUsage.turns),
            };
            this.previousUsage = event.usage;
          }
        }
        const summary = terminalSummary(event.response.stopReason, event.cancellationCategory);
        this.sink.event({
          type: "result",
          success: summary.success,
          text: summary.fallback,
          cancelled: event.response.stopReason === "cancelled",
          usage,
        });
        break;
      }
      case "prompt_error":
        this.sink.event({ type: "result", success: false, text: event.message });
        break;
      case "fatal":
        this.sink.event({ type: "fatal", message: event.message });
        break;
    }
  }

  private onUpdate(update: NormalizedUpdate): void {
    if (!this.sink) return;
    switch (update.kind) {
      case "user":
      case "thought":
      case "usage_context":
      case "metadata":
        break;
      case "prose":
        this.sink.event({ type: "prose", text: update.text });
        break;
      case "unsupported_content":
        this.sink.event({
          type: "notification",
          title: "Unsupported Grok content",
          message: `The response included ${update.contentType} content that cannot be shown on the glasses.`,
        });
        break;
      case "tool":
        this.emitTool(update.patch);
        break;
      case "plan":
        this.sink.event({ type: "plan", entries: update.entries });
        break;
    }
  }

  private emitTool(patch: NormalizedToolPatch): void {
    if (!this.sink) return;
    const status = patch.status === "completed" || patch.status === "failed" || patch.status === "pending"
      ? patch.status
      : "running";
    this.sink.event({
      type: "tool",
      id: patch.id,
      name: patch.title?.trim() || patch.kind || "Grok tool",
      status,
      ...(patch.present.includes("rawInput") ? { input: patch.rawInput } : {}),
      ...(patch.present.includes("rawOutput")
        ? { output: readableValue(patch.rawOutput) }
        : patch.present.includes("content")
          ? { output: patch.content ?? "" }
          : {}),
    });
  }

  private emitQuestion(pending: PendingQuestion): void {
    if (!this.sink) return;
    const source = pending.request.questions[pending.index];
    const question: OwnedQuestion = {
      question: source.question,
      header: "Grok",
      multiSelect: source.multiSelect,
      options: source.options.map((option) => ({
        label: option.label,
        description: option.description,
        ...(option.preview ? { preview: option.preview } : {}),
      })),
    };
    this.sink.event({
      type: "question",
      id: pending.id,
      question,
      index: pending.index,
      total: pending.request.questions.length,
    });
  }

  private normalizeAnswer(
    question: NormalizedQuestion,
    answer: string,
  ): { labels: string[]; annotation?: { preview?: string; notes?: string } } {
    let submitted: string[] = [answer];
    try {
      const parsed = JSON.parse(answer) as unknown;
      const value = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? Object.values(parsed as Record<string, unknown>)[0]
        : parsed;
      if (typeof value === "string") submitted = [value];
      else if (question.multiSelect && Array.isArray(value) && value.every((item) => typeof item === "string")) {
        submitted = value as string[];
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
      return { labels, ...(preview ? { annotation: { preview } } : {}) };
    }
    return { labels: ["Other"], annotation: { notes: answer } };
  }
}
