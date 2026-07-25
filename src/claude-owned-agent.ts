import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo, OwnedQuestion } from "./owned-agent.js";
import type { OwnedProviderConfig } from "./owned-config.js";

type CanUseToolOptions = Parameters<CanUseTool>[2];

const STDERR_TAIL_LIMIT = 4_000;

interface PendingPermission {
  kind: "permission";
  toolUseId: string;
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

interface ClaudeQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

interface PendingQuestion {
  kind: "question";
  toolUseId: string;
  input: Record<string, unknown>;
  questions: ClaudeQuestion[];
  index: number;
  answers: Record<string, string | string[]>;
  resolve: (result: PermissionResult) => void;
}

/** The SDK dispatches can_use_tool concurrently; the glasses answer one prompt at a time. */
type PendingInteraction = PendingPermission | PendingQuestion;

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed.");
    const waiter = this.waiting.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.values.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => readable(isRecord(entry) && "text" in entry ? entry.text : entry)).filter(Boolean).join("\n");
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseQuestions(input: Record<string, unknown>): ClaudeQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  const questions: ClaudeQuestion[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== "string") continue;
    const options: ClaudeQuestion["options"] = [];
    if (Array.isArray(raw.options)) {
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.label !== "string") continue;
        options.push({
          label: option.label,
          description: typeof option.description === "string" ? option.description : "",
          ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
        });
      }
    }
    questions.push({
      question: raw.question,
      header: typeof raw.header === "string" ? raw.header : "Claude",
      options,
      multiSelect: raw.multiSelect === true,
    });
  }
  return questions;
}

function normalizeQuestionAnswer(question: ClaudeQuestion, answer: string): string | string[] {
  let submitted: unknown = answer;
  try {
    const parsed = JSON.parse(answer) as unknown;
    submitted = isRecord(parsed) ? Object.values(parsed)[0] : parsed;
  } catch {
    // Plain labels and free text remain unchanged.
  }
  const values = Array.isArray(submitted) && question.multiSelect
    ? submitted.filter((value): value is string => typeof value === "string")
    : [typeof submitted === "string" ? submitted : answer];
  const labels = values.map((value) =>
    question.options.find((option) => option.label.toLowerCase() === value.trim().toLowerCase())?.label ?? value,
  );
  return question.multiSelect ? labels : labels[0] ?? answer;
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Long-lived Claude Agent SDK query using the user's installed Claude binary. */
export class ClaudeOwnedAgent implements OwnedAgent {
  readonly provider = "claude" as const;
  private readonly input = new MessageQueue();
  private sink: OwnedAgentSink | null = null;
  private queryHandle: Query | null = null;
  private consumePromise: Promise<void> | null = null;
  private readonly interactions: PendingInteraction[] = [];
  private stderrTail = "";
  private active = false;
  private disposed = false;

  constructor(
    readonly cwd: string,
    private readonly config: OwnedProviderConfig,
    private readonly queryFactory: typeof query = query,
  ) {}

  async start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    this.sink = sink;
    // The CLI emits system/init only once a turn begins, and the first prompt is not sent
    // until start() resolves — so startup must never wait for it. Naming the session up
    // front is what makes the id knowable before the first turn.
    const sessionId = nativeSessionId ?? randomUUID();
    this.queryHandle = this.queryFactory({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        pathToClaudeCodeExecutable: this.config.bin,
        env: this.config.env,
        permissionMode: "default",
        persistSession: true,
        stderr: (data: string) => {
          this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL_LIMIT);
        },
        // `sessionId` is rejected alongside `resume` unless the session is forked.
        ...(nativeSessionId ? { resume: nativeSessionId } : { sessionId }),
        canUseTool: (toolName, input, options) => this.enqueueInteraction(toolName, input, options),
      },
    });
    this.consumePromise = this.consume();
    try {
      await timeout(
        this.queryHandle.initializationResult(),
        this.config.startupTimeoutMs,
        "Claude startup timed out. Check the Claude executable and authentication.",
      );
      // initializationResult() carries no active model; system/init reports it on turn one.
      return { nativeSessionId: sessionId, model: "" };
    } catch (error) {
      await this.dispose();
      const detail = this.stderrTail.trim();
      throw new Error(`Claude could not start. Run claude once to verify authentication. ${error instanceof Error ? error.message : String(error)}${detail ? ` ${detail}` : ""}`);
    }
  }

  prompt(text: string): Promise<void> {
    if (this.disposed || !this.queryHandle) throw new Error("Claude session ended; create another session.");
    if (this.active) throw new Error("Claude is already processing a prompt.");
    this.active = true;
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    return Promise.resolve();
  }

  respondPermission(decision: string): Promise<void> {
    const pending = this.interactions[0];
    if (!pending || pending.kind !== "permission") return Promise.reject(new Error("No matching Claude permission."));
    this.interactions.shift();
    if (decision === "allow" || decision === "allowAlways") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        ...(decision === "allowAlways"
          ? { updatedPermissions: pending.suggestions.filter((suggestion) => "destination" in suggestion && suggestion.destination === "session") }
          : {}),
      });
    } else {
      pending.resolve({ behavior: "deny", message: "User denied this action." });
    }
    this.presentHead();
    return Promise.resolve();
  }

  respondQuestion(answer: string): Promise<void> {
    const pending = this.interactions[0];
    if (!pending || pending.kind !== "question") return Promise.reject(new Error("No matching Claude question."));
    const question = pending.questions[pending.index];
    pending.answers[question.question] = normalizeQuestionAnswer(question, answer);
    pending.index++;
    if (pending.index < pending.questions.length) {
      this.emitQuestion(pending);
      return Promise.resolve();
    }
    this.interactions.shift();
    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.input, questions: pending.questions, answers: pending.answers },
    });
    this.presentHead();
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    this.rejectInteractions("Session interrupted.");
    if (!this.queryHandle || !this.active) return;
    await timeout(
      this.queryHandle.interrupt().then(() => undefined),
      this.config.cancelTimeoutMs,
      "Claude did not acknowledge interruption.",
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectInteractions("Session ended.");
    this.input.close();
    this.queryHandle?.close();
    if (this.consumePromise) {
      try {
        await timeout(this.consumePromise, this.config.shutdownTimeoutMs, "Claude shutdown timed out.");
      } catch {
        // Query.close() is the SDK's terminal teardown; do not extend shutdown indefinitely.
      }
    }
    this.queryHandle = null;
  }

  /**
   * The SDK fires can_use_tool for every tool in a batched assistant message at once. Only
   * the queue head is ever shown; the rest stay pending so none is orphaned — an orphaned
   * request blocks the CLI forever and the turn never reaches `result`.
   */
  private enqueueInteraction(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    if (!this.sink) return Promise.resolve({ behavior: "deny", message: "Owned session is unavailable." });
    const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : [];
    if (toolName === "AskUserQuestion" && !questions.length) {
      return Promise.resolve({ behavior: "deny", message: "Claude sent an invalid question." });
    }
    return new Promise((resolve) => {
      const pending: PendingInteraction = questions.length
        ? { kind: "question", toolUseId: options.toolUseID, input, questions, index: 0, answers: {}, resolve }
        : {
            kind: "permission",
            toolUseId: options.toolUseID,
            toolName,
            description: options.title || options.displayName || readable(input),
            input,
            suggestions: options.suggestions ?? [],
            resolve,
          };
      this.interactions.push(pending);
      options.signal.addEventListener("abort", () => this.cancelInteraction(pending), { once: true });
      if (this.interactions[0] === pending) this.present(pending);
    });
  }

  private cancelInteraction(pending: PendingInteraction): void {
    const index = this.interactions.indexOf(pending);
    if (index === -1) return;
    this.interactions.splice(index, 1);
    pending.resolve({
      behavior: "deny",
      message: pending.kind === "question" ? "Question cancelled." : "Permission request cancelled.",
    });
    if (index === 0) this.presentHead();
  }

  private presentHead(): void {
    const head = this.interactions[0];
    if (head) this.present(head);
  }

  private present(pending: PendingInteraction): void {
    if (pending.kind === "question") {
      this.emitQuestion(pending);
      return;
    }
    const sessionSuggestion = pending.suggestions.some((suggestion) => "destination" in suggestion && suggestion.destination === "session");
    this.sink?.event({
      type: "permission",
      id: `claude-permission:${pending.toolUseId}`,
      // The real tool id, so the bridge attaches this to the tool's existing bubble.
      toolId: pending.toolUseId,
      toolName: pending.toolName,
      description: pending.description,
      options: [
        { key: "allow", label: "Allow once" },
        ...(sessionSuggestion ? [{ key: "allowAlways" as const, label: "Allow for session" }] : []),
        { key: "deny", label: "Deny" },
      ],
    });
  }

  private emitQuestion(pending: PendingQuestion): void {
    const source = pending.questions[pending.index];
    const question: OwnedQuestion = {
      question: source.question,
      header: source.header,
      options: source.options,
      multiSelect: source.multiSelect,
    };
    this.sink?.event({
      type: "question",
      id: `claude-question:${pending.toolUseId}:${pending.index}`,
      question,
      index: pending.index,
      total: pending.questions.length,
    });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryHandle!) this.onMessage(message);
      if (!this.disposed) this.sink?.event({ type: "fatal", message: "Claude process exited unexpectedly." });
    } catch (error) {
      if (!this.disposed) {
        this.sink?.event({ type: "fatal", message: `Claude process failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  private onMessage(message: SDKMessage): void {
    if (!this.sink) return;
    if (message.type === "system" && message.subtype === "init") {
      // Arrives with turn one; the catalog persists it over the placeholder from start().
      this.sink.event({ type: "model", model: message.model });
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          this.sink.event({ type: "prose", text: block.text });
        } else if (block.type === "tool_use") {
          if (block.name === "TodoWrite" && isRecord(block.input) && Array.isArray(block.input.todos)) {
            const entries = block.input.todos.flatMap((todo) => {
              if (!isRecord(todo) || typeof todo.content !== "string") return [];
              const status: "completed" | "in_progress" | "pending" =
                todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending";
              return [{ content: todo.content, status }];
            });
            this.sink.event({ type: "plan", entries });
          } else {
            this.sink.event({ type: "tool", id: block.id, name: block.name, status: "running", input: block.input });
          }
        }
      }
      return;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        this.sink.event({
          type: "tool",
          id: block.tool_use_id,
          name: "Claude tool",
          status: block.is_error === true ? "failed" : "completed",
          output: readable(block.content),
        });
      }
      return;
    }
    if (message.type === "result") {
      this.active = false;
      this.rejectInteractions("Turn ended.");
      this.sink.event({
        type: "result",
        success: message.subtype === "success",
        cancelled: message.stop_reason === "cancelled",
        text: message.subtype === "success" ? message.result : message.errors.join("\n"),
        costUsd: message.total_cost_usd,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          turns: message.num_turns,
        },
      });
    }
  }

  private rejectInteractions(reason: string): void {
    for (const pending of this.interactions.splice(0)) {
      pending.resolve({ behavior: "deny", message: reason });
    }
  }
}
