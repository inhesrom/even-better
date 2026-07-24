import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo, OwnedQuestion } from "./owned-agent.js";
import type { OwnedProviderConfig } from "./owned-config.js";

interface PendingPermission {
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
  input: Record<string, unknown>;
  questions: ClaudeQuestion[];
  index: number;
  answers: Record<string, string | string[]>;
  resolve: (result: PermissionResult) => void;
}

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
  private permission: PendingPermission | null = null;
  private question: PendingQuestion | null = null;
  private active = false;
  private disposed = false;
  private resolveIdentity: ((info: OwnedAgentStartInfo) => void) | null = null;

  constructor(
    readonly cwd: string,
    private readonly config: OwnedProviderConfig,
    private readonly queryFactory: typeof query = query,
  ) {}

  async start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    this.sink = sink;
    const identity = new Promise<OwnedAgentStartInfo>((resolve) => {
      this.resolveIdentity = resolve;
    });
    this.queryHandle = this.queryFactory({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        pathToClaudeCodeExecutable: this.config.bin,
        env: this.config.env,
        permissionMode: "default",
        persistSession: true,
        ...(nativeSessionId ? { resume: nativeSessionId } : {}),
        canUseTool: (toolName, input, options) => this.canUseTool(toolName, input, options.suggestions ?? [], options.signal),
      },
    });
    this.consumePromise = this.consume();
    try {
      await timeout(Promise.all([
        this.queryHandle.initializationResult(),
        identity,
      ]),
        this.config.startupTimeoutMs,
        "Claude startup timed out. Check the Claude executable and authentication.",
      );
      return await identity;
    } catch (error) {
      await this.dispose();
      throw new Error(`Claude could not start. Run claude once to verify authentication. ${error instanceof Error ? error.message : String(error)}`);
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
    const pending = this.permission;
    if (!pending) return Promise.reject(new Error("No matching Claude permission."));
    this.permission = null;
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
    return Promise.resolve();
  }

  respondQuestion(answer: string): Promise<void> {
    const pending = this.question;
    if (!pending) return Promise.reject(new Error("No matching Claude question."));
    const question = pending.questions[pending.index];
    pending.answers[question.question] = normalizeQuestionAnswer(question, answer);
    pending.index++;
    if (pending.index < pending.questions.length) {
      this.emitQuestion(pending);
      return Promise.resolve();
    }
    this.question = null;
    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.input, questions: pending.questions, answers: pending.answers },
    });
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    this.rejectInteractions();
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
    this.rejectInteractions();
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

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[],
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (!this.sink) return Promise.resolve({ behavior: "deny", message: "Owned session is unavailable." });
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (!questions.length) return Promise.resolve({ behavior: "deny", message: "Claude sent an invalid question." });
      return new Promise((resolve) => {
        const pending: PendingQuestion = { input, questions, index: 0, answers: {}, resolve };
        this.question = pending;
        signal.addEventListener("abort", () => {
          if (this.question === pending) {
            this.question = null;
            resolve({ behavior: "deny", message: "Question cancelled." });
          }
        }, { once: true });
        this.emitQuestion(pending);
      });
    }
    return new Promise((resolve) => {
      const pending: PendingPermission = { input, suggestions, resolve };
      this.permission = pending;
      signal.addEventListener("abort", () => {
        if (this.permission === pending) {
          this.permission = null;
          resolve({ behavior: "deny", message: "Permission request cancelled." });
        }
      }, { once: true });
      const sessionSuggestion = suggestions.some((suggestion) => "destination" in suggestion && suggestion.destination === "session");
      this.sink!.event({
        type: "permission",
        id: `claude-permission:${Date.now()}`,
        toolId: `claude-tool:${Date.now()}`,
        toolName,
        description: readable(input),
        options: [
          { key: "allow", label: "Allow once" },
          ...(sessionSuggestion ? [{ key: "allowAlways" as const, label: "Allow for session" }] : []),
          { key: "deny", label: "Deny" },
        ],
      });
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
      id: `claude-question:${pending.index}`,
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
      this.sink.event({ type: "model", model: message.model });
      this.resolveIdentity?.({ nativeSessionId: message.session_id, model: message.model });
      this.resolveIdentity = null;
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
      this.permission = null;
      this.question = null;
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

  private rejectInteractions(): void {
    const permission = this.permission;
    this.permission = null;
    permission?.resolve({ behavior: "deny", message: "Session interrupted." });
    const question = this.question;
    this.question = null;
    question?.resolve({ behavior: "deny", message: "Question cancelled." });
  }
}
