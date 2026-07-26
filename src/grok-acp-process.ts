import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { GrokConfig } from "./grok-config.js";
import { parseGrokVersion, supportedGrokVersion } from "./grok-config.js";
import { redactGrokDiagnostic } from "./grok-redact.js";
import {
  isRecord,
  normalizeSessionNotification,
  parseQuestionRequest,
  parseXaiTurnCompleted,
  promptMeta,
  type JsonRecord,
  type NormalizedPromptResponse,
  type NormalizedQuestionRequest,
  type NormalizedUpdate,
  type TerminalUsage,
} from "./grok-acp-normalize.js";

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export type GrokProcessEvent =
  | { type: "update"; update: NormalizedUpdate }
  | {
      type: "permission";
      interactionId: string;
      toolId: string;
      toolName: string;
      description: string;
      options: Array<{ key: PermissionDecision; label: string }>;
    }
  | { type: "question"; interactionId: string; request: NormalizedQuestionRequest }
  | {
      type: "terminal";
      response: NormalizedPromptResponse;
      usage?: TerminalUsage;
      cancellationCategory?: string;
    }
  | { type: "prompt_error"; message: string }
  | { type: "fatal"; message: string };

interface PendingPermission {
  id: string;
  options: Map<PermissionDecision, { optionId: string; label: string }>;
  resolve: (response: RequestPermissionResponse) => void;
}

interface PendingQuestion {
  id: string;
  resolve: (response: JsonRecord) => void;
}

function parser<T>(parse: (value: unknown) => T): { parse(value: unknown): T } {
  return { parse };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authError(method: string): Error {
  return new Error(
    `Grok authentication failed for ${method}. Check XAI_API_KEY or run grok login, then retry.`,
  );
}

function choiceMap(options: PermissionOption[]): Map<PermissionDecision, { optionId: string; label: string }> {
  const map = new Map<PermissionDecision, { optionId: string; label: string }>();
  const rejectOnce = options.find((option) => option.kind === "reject_once");
  for (const option of options) {
    const key: PermissionDecision | null =
      option.kind === "allow_once"
        ? "allow"
        : option.kind === "allow_always"
          ? "allowAlways"
          : option.kind === "reject_once" || (option.kind === "reject_always" && !rejectOnce)
            ? "deny"
            : null;
    if (key && !map.has(key)) map.set(key, { optionId: option.optionId, label: option.name });
  }
  return map;
}

function modelFrom(value: unknown): string {
  if (!isRecord(value)) return "";
  if (isRecord(value.models) && typeof value.models.currentModelId === "string") {
    return value.models.currentModelId;
  }
  if (isRecord(value.modelState) && typeof value.modelState.currentModelId === "string") {
    return value.modelState.currentModelId;
  }
  if (isRecord(value._meta)) return modelFrom(value._meta);
  return "";
}

function validAcpLine(line: string): boolean {
  if (!line.trim()) return true;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) || Array.isArray(value);
  } catch {
    return false;
  }
}

function strictAcpInput(
  input: ReadableStream<Uint8Array>,
  onInvalid: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let tail = "";
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tail += decoder.decode(chunk, { stream: true });
        for (;;) {
          const newline = tail.indexOf("\n");
          if (newline < 0) break;
          const line = tail.slice(0, newline);
          tail = tail.slice(newline + 1);
          if (!validAcpLine(line)) {
            onInvalid();
            throw new Error("Invalid ACP input.");
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        tail += decoder.decode();
        if (!validAcpLine(tail)) {
          onInvalid();
          throw new Error("Invalid ACP input.");
        }
      },
    }),
  );
}

/** Sole owner of the Grok child, ACP connection, opaque ids, and pending callbacks. */
export class GrokAcpProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientConnection | null = null;
  private context: acp.ClientContext | null = null;
  private sessionId = "";
  private provisionalSessionId: string | null = null;
  private capabilities: AgentCapabilities = {};
  private listeners = new Set<(event: GrokProcessEvent) => void>();
  private pendingPermission: PendingPermission | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private activePrompt: Promise<void> | null = null;
  private inboundTail: Promise<void> = Promise.resolve();
  private cancelTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
  private promptTerminalSeen = false;
  private closing = false;
  private available = false;
  private fatalEmitted = false;
  private disposePromise: Promise<void> | null = null;
  private stderrTail = "";
  private xaiTerminals = new Map<string, ReturnType<typeof parseXaiTurnCompleted>>();
  private latestXaiTerminal: ReturnType<typeof parseXaiTurnCompleted> = null;
  private xaiWaiters = new Map<string, Set<() => void>>();
  private seenEventIds = new Set<string>();
  private suppressSessionUpdates = false;

  constructor(private readonly config: GrokConfig) {}

  get isAvailable(): boolean {
    return this.available;
  }

  get hasActivePrompt(): boolean {
    return this.activePrompt !== null;
  }

  onEvent(listener: (event: GrokProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: GrokProcessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(nativeSessionId?: string): Promise<{ model: string; version: string; sessionId: string }> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let versionOutput: string;
    try {
      versionOutput = await this.probeVersion(deadline);
    } catch (error) {
      if (/timed out/.test(safeError(error))) throw error;
      throw new Error("Cannot run Grok from GROK_BIN. Check that it is installed and executable.");
    }
    const version = parseGrokVersion(versionOutput);
    if (!version || !supportedGrokVersion(version)) {
      throw new Error("Grok 0.2.103 or newer is required.");
    }

    this.child = spawn(this.config.bin, ["--no-auto-update", "agent", "stdio"], {
      cwd: this.config.cwd,
      env: this.config.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.captureStderr(this.child);
    await this.beforeDeadline(
      new Promise<void>((resolve, reject) => {
        this.child!.once("spawn", resolve);
        this.child!.once("error", reject);
      }),
      deadline,
      "spawn",
    ).catch(async () => {
      await this.dispose();
      throw new Error("Cannot run Grok from GROK_BIN. Check that it is installed and executable.");
    });
    this.child.on("error", () => this.fatal("Lost the Grok ACP connection."));
    this.child.once("exit", (code, signal) => {
      if (this.closing) return;
      const quota = /402|spending.limit|run out of credits/i.test(this.stderrTail);
      this.fatal(
        quota
          ? "Grok account has no available usage. Add credits or update the Grok subscription, then retry."
          : code === 0
            ? "Grok exited before the session ended."
            : `Grok process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`,
      );
    });

    const app = acp
      .client({ name: "even-better" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.enqueueInbound(() => this.handlePermission(ctx.params)),
      )
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.enqueueInbound(() => this.handleSessionUpdate(ctx.params)),
      )
      .onRequest<NormalizedQuestionRequest | null, JsonRecord>(
        "_x.ai/ask_user_question",
        parser(parseQuestionRequest),
        (ctx) => {
          const params = ctx.params;
          if (!params) {
            this.fatal("Grok sent invalid ACP data. Restart even-better and verify the Grok version.");
            return Promise.resolve({ outcome: "cancelled" });
          }
          return this.enqueueInbound(() => this.handleQuestion(params));
        },
      )
      .onNotification<JsonRecord | null>(
        "_x.ai/session_notification",
        parser((value) => (isRecord(value) ? value : null)),
        (ctx) => {
          const params = ctx.params;
          if (!params) {
            this.fatal("Grok sent invalid ACP data. Restart even-better and verify the Grok version.");
            return;
          }
          return this.enqueueInbound(() => this.handleXaiNotification(params));
        },
      );

    const output = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>;
    const input = strictAcpInput(
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      () => this.fatal("Grok sent invalid ACP data. Restart even-better and verify the Grok version."),
    );
    this.connection = app.connect(acp.ndJsonStream(output, input));
    this.context = this.connection.agent;
    void this.connection.closed.then(
      () => {
        if (!this.closing) this.fatal("Lost the Grok ACP connection.");
      },
      () => {
        if (!this.closing) this.fatal("Lost the Grok ACP connection.");
      },
    );

    try {
      const initialized = await this.beforeDeadline(
        this.context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "even-better", title: "even-better", version: "0.1.0" },
        }),
        deadline,
        "initialize",
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error("Grok does not provide the required ACP v1 contract. Upgrade Grok and retry.");
      }
      this.capabilities = initialized.agentCapabilities ?? {};
      const method = initialized.authMethods?.find((item) => item.id === "xai.api_key")?.id
        ?? initialized.authMethods?.find((item) => item.id === "cached_token")?.id;
      if (!method) {
        throw new Error(
          "Grok authentication is unavailable. Set XAI_API_KEY or run grok login, then retry.",
        );
      }
      try {
        await this.beforeDeadline(
          this.context.request(acp.methods.agent.authenticate, {
            methodId: method,
            _meta: { headless: true },
          }),
          deadline,
          "authenticate",
        );
      } catch (error) {
        if (/timed out/.test(safeError(error))) throw error;
        throw authError(method);
      }
      let sessionInfo: unknown;
      if (nativeSessionId) {
        this.sessionId = nativeSessionId;
        this.suppressSessionUpdates = true;
        const params = { sessionId: nativeSessionId, cwd: this.config.cwd, mcpServers: [] };
        try {
          if (this.capabilities.loadSession) {
            try {
              sessionInfo = await this.beforeDeadline(
                this.context.request(acp.methods.agent.session.load, params),
                deadline,
                "session load",
              );
            } catch (error) {
              if (!this.capabilities.sessionCapabilities?.resume) throw error;
              sessionInfo = await this.beforeDeadline(
                this.context.request(acp.methods.agent.session.resume, params),
                deadline,
                "session resume",
              );
            }
          } else if (this.capabilities.sessionCapabilities?.resume) {
            sessionInfo = await this.beforeDeadline(
              this.context.request(acp.methods.agent.session.resume, params),
              deadline,
              "session resume",
            );
          } else {
            throw new Error("Grok does not advertise session/load or session/resume; update Grok before reopening this remembered session.");
          }
        } catch (error) {
          if (/timed out/.test(safeError(error))) throw error;
          throw new Error(`Grok could not resume session ${nativeSessionId}. ${safeError(error)}`);
        } finally {
          await this.inboundTail;
          this.suppressSessionUpdates = false;
        }
      } else {
        try {
          const session = await this.beforeDeadline(
            this.context.request(acp.methods.agent.session.new, {
              cwd: this.config.cwd,
              mcpServers: [],
            }),
            deadline,
            "session creation",
          );
          this.sessionId = session.sessionId;
          sessionInfo = session;
        } catch (error) {
          if (/timed out/.test(safeError(error))) throw error;
          throw new Error(
            "Grok could not create a session in the chosen directory. Check directory access and Grok configuration.",
          );
        }
      }
      await this.inboundTail;
      if (this.closing) throw new Error("Grok ended during session creation.");
      if (this.provisionalSessionId && this.provisionalSessionId !== this.sessionId) {
        throw new Error("Grok sent ACP data for the wrong session during startup.");
      }
      this.available = true;
      return {
        version: version.display,
        model: modelFrom(sessionInfo) || modelFrom(initialized) || "Unknown",
        sessionId: this.sessionId,
      };
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async prompt(text: string): Promise<void> {
    if (!this.available || !this.context || !this.sessionId) {
      throw new Error("Grok session ended; restart even-better.");
    }
    if (this.activePrompt) throw new Error("Grok is already processing a prompt.");
    this.cancelRequested = false;
    this.promptTerminalSeen = false;
    this.latestXaiTerminal = null;
    this.activePrompt = this.runPrompt(text);
    void this.activePrompt.finally(() => {
      this.activePrompt = null;
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    });
  }

  private async runPrompt(text: string): Promise<void> {
    try {
      const response = await this.context!.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      await this.inboundTail;
      const meta = promptMeta(response);
      if (meta.promptId && !this.xaiTerminals.has(meta.promptId)) {
        // The SDK dispatches notifications independently from request responses.
        // Give Grok's immediately preceding terminal extension a brief chance to
        // finish parsing before publishing the one authoritative turn result.
        await this.waitForXaiTerminal(meta.promptId, 100);
      }
      const extension =
        (meta.promptId ? this.xaiTerminals.get(meta.promptId) : null) ?? this.latestXaiTerminal;
      this.promptTerminalSeen = true;
      this.emit({
        type: "terminal",
        response,
        ...(extension?.usage || meta.usage ? { usage: extension?.usage ?? meta.usage } : {}),
        ...(meta.cancellationCategory || extension?.cancellationCategory
          ? { cancellationCategory: meta.cancellationCategory ?? extension?.cancellationCategory }
          : {}),
      });
    } catch (error) {
      if (!this.closing) {
        this.promptTerminalSeen = true;
        this.emit({ type: "prompt_error", message: this.safePromptError(error) });
      }
    }
  }

  async respondPermission(interactionId: string, decision: PermissionDecision): Promise<string> {
    const pending = this.pendingPermission;
    if (!pending || pending.id !== interactionId) throw new Error("No matching Grok permission request.");
    const option = pending.options.get(decision);
    if (!option) throw new Error("That permission choice was not offered by Grok.");
    this.pendingPermission = null;
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    return option.label;
  }

  async respondQuestion(interactionId: string, response: JsonRecord): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending || pending.id !== interactionId) throw new Error("No matching Grok question.");
    this.pendingQuestion = null;
    pending.resolve(response);
  }

  async cancel(): Promise<void> {
    if (!this.activePrompt || !this.context || !this.sessionId) return;
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.cancelPendingInteraction();
    try {
      await this.withTimeout(
        this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }),
        this.config.cancelTimeoutMs,
        "cancel notification",
      );
    } catch (error) {
      this.fatal("Could not send interruption to Grok; the process was terminated.");
      throw error;
    }
    if (!this.cancelTimer) {
      this.cancelTimer = setTimeout(() => {
        this.fatal("Grok did not stop after interruption and was terminated.");
      }, this.config.cancelTimeoutMs);
    }
  }

  private handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (
      this.promptTerminalSeen
      || params.sessionId !== this.sessionId
      || this.pendingPermission
      || this.pendingQuestion
    ) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.handleSessionUpdate({
      sessionId: params.sessionId,
      update: { ...params.toolCall, sessionUpdate: "tool_call_update" },
    });
    const options = choiceMap(params.options);
    if (!options.size) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const id = randomUUID();
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermission = { id, options, resolve };
      this.emit({
        type: "permission",
        interactionId: id,
        toolId: params.toolCall.toolCallId,
        toolName: params.toolCall.title ?? params.toolCall.kind ?? "Grok tool",
        description: params.toolCall.title ?? "Grok requests permission",
        options: [...options].map(([key, option]) => ({ key, label: option.label })),
      });
    });
  }

  private handleQuestion(request: NormalizedQuestionRequest): Promise<JsonRecord> {
    if (
      this.promptTerminalSeen
      || request.sessionId !== this.sessionId
      || this.pendingPermission
      || this.pendingQuestion
    ) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    const id = randomUUID();
    return new Promise<JsonRecord>((resolve) => {
      this.pendingQuestion = { id, resolve };
      this.emit({ type: "question", interactionId: id, request });
    });
  }

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    if (this.suppressSessionUpdates && notification.sessionId === this.sessionId) return;
    if (this.promptTerminalSeen || !this.acceptEvent(notification._meta)) return;
    if (!this.sessionId) {
      if (!this.provisionalSessionId) this.provisionalSessionId = notification.sessionId;
      if (notification.sessionId === this.provisionalSessionId) {
        this.emit({ type: "update", update: normalizeSessionNotification(notification) });
        return;
      }
    }
    if (notification.sessionId !== this.sessionId) {
      this.fatal("Grok sent invalid ACP data. Restart even-better and verify the Grok version.");
      return;
    }
    this.emit({ type: "update", update: normalizeSessionNotification(notification) });
  }

  private handleXaiNotification(params: JsonRecord): void {
    if (this.promptTerminalSeen || !this.acceptEvent(params._meta)) return;
    const terminal = parseXaiTurnCompleted(params);
    if (!terminal) return;
    this.xaiTerminals.set(terminal.promptId, terminal);
    this.latestXaiTerminal = terminal;
    const waiters = this.xaiWaiters.get(terminal.promptId);
    if (waiters) {
      this.xaiWaiters.delete(terminal.promptId);
      for (const resolve of waiters) resolve();
    }
  }

  private enqueueInbound<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.inboundTail.then(task);
    this.inboundTail = run.then(
      () => undefined,
      () => {
        this.fatal("Grok sent invalid ACP data. Restart even-better and verify the Grok version.");
      },
    );
    return run;
  }

  private acceptEvent(meta: unknown): boolean {
    if (!isRecord(meta) || typeof meta.eventId !== "string") return true;
    if (this.seenEventIds.has(meta.eventId)) return false;
    this.seenEventIds.add(meta.eventId);
    if (this.seenEventIds.size > 2_048) {
      const oldest = this.seenEventIds.values().next().value;
      if (typeof oldest === "string") this.seenEventIds.delete(oldest);
    }
    return true;
  }

  private safePromptError(error: unknown): string {
    const message = safeError(error);
    if (/402|spending.limit|run out of credits/i.test(message + this.stderrTail)) {
      return "Grok account has no available usage. Add credits or update the Grok subscription, then retry.";
    }
    return "Grok could not complete the prompt. Check the Grok session and retry.";
  }

  private waitForXaiTerminal(promptId: string, timeoutMs: number): Promise<void> {
    if (this.xaiTerminals.has(promptId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.xaiWaiters.get(promptId) ?? new Set<() => void>();
      let timer: NodeJS.Timeout;
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size) this.xaiWaiters.delete(promptId);
        resolve();
      };
      waiters.add(done);
      this.xaiWaiters.set(promptId, waiters);
      timer = setTimeout(done, timeoutMs);
    });
  }

  private cancelPendingInteraction(): void {
    if (this.pendingPermission) {
      const pending = this.pendingPermission;
      this.pendingPermission = null;
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    if (this.pendingQuestion) {
      const pending = this.pendingQuestion;
      this.pendingQuestion = null;
      pending.resolve({ outcome: "cancelled" });
    }
  }

  private fatal(message: string): void {
    if (this.closing || this.fatalEmitted || !this.available && !this.child) return;
    this.fatalEmitted = true;
    this.available = false;
    this.emit({ type: "fatal", message });
    // Best-effort teardown. disposeOwned() throws when the process group cannot
    // be reaped; unhandled here that rejection reaches index.ts's
    // unhandledRejection handler, which calls shutdown(1) for owned/grok — so
    // one un-reapable child would take down the whole server.
    void this.dispose().catch((error) => {
      console.warn(`[grok] teardown after fatal failed: ${(error as Error).message}`);
    });
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOwned();
    return this.disposePromise;
  }

  private async disposeOwned(): Promise<void> {
    this.closing = true;
    this.available = false;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.cancelPendingInteraction();
    if (this.activePrompt && this.context && this.sessionId) {
      try {
        await this.withTimeout(
          this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }),
          this.config.cancelTimeoutMs,
          "shutdown cancellation",
        );
        await Promise.race([
          this.activePrompt,
          new Promise<void>((resolve) => setTimeout(resolve, this.config.cancelTimeoutMs)),
        ]);
      } catch {
        // Teardown continues through transport/process escalation.
      }
    }
    if (this.context && this.sessionId && this.capabilities.sessionCapabilities?.close) {
      try {
        await this.withTimeout(
          this.context.request(acp.methods.agent.session.close, { sessionId: this.sessionId }),
          this.config.shutdownTimeoutMs,
          "session close",
        );
      } catch {
        // EOF/signals are the authoritative fallback.
      }
    }
    const child = this.child;
    let reaped = true;
    if (child) {
      child.stdin.end();
      if (!(await this.waitForOwnedShutdown(child, this.config.shutdownTimeoutMs))) {
        this.signalOwned("SIGTERM");
        if (!(await this.waitForOwnedShutdown(child, this.config.shutdownTimeoutMs))) {
          this.signalOwned("SIGKILL");
          reaped = await this.waitForOwnedShutdown(child, this.config.shutdownTimeoutMs);
        }
      }
    }
    this.connection?.close();
    this.connection = null;
    this.context = null;
    this.child = null;
    for (const waiters of this.xaiWaiters.values()) for (const resolve of waiters) resolve();
    this.xaiWaiters.clear();
    this.listeners.clear();
    if (!reaped) throw new Error("The owned Grok process group could not be reaped.");
  }

  private signalOwned(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already reaped.
    }
  }

  private async waitForOwnedShutdown(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const childExited = !child.pid || child.exitCode !== null || child.signalCode !== null;
      if (childExited && !this.ownedGroupExists(child)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  private ownedGroupExists(child: ChildProcessWithoutNullStreams): boolean {
    if (process.platform === "win32") {
      return child.exitCode === null && child.signalCode === null;
    }
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private captureStderr(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const redacted = redactGrokDiagnostic(chunk);
      this.stderrTail = (this.stderrTail + redacted).slice(-8192);
    });
  }

  private async probeVersion(deadline: number): Promise<string> {
    const child = spawn(this.config.bin, ["--version"], {
      cwd: this.config.cwd,
      env: this.config.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    const result = new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`Cannot run Grok from GROK_BIN (version exited ${code ?? "unknown"}).`));
      });
    });
    try {
      return await this.beforeDeadline(result, deadline, "version");
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }

  private beforeDeadline<T>(promise: Promise<T>, deadline: number, phase: string): Promise<T> {
    return this.withTimeout(promise, Math.max(1, deadline - Date.now()), `startup ${phase}`);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Grok ${phase} timed out.`)), timeoutMs);
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
}
