import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  AgentMode,
  OwnedAgent,
  OwnedAgentSink,
  OwnedAgentStartInfo,
  OwnedPermissionDecision,
  OwnedQuestion,
} from "./owned-agent.js";
import type { OwnedProviderConfig } from "./owned-config.js";

type RequestId = number;

interface PendingRpc {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface CodexTool {
  name: string;
  input: unknown;
  output: string;
}

interface PermissionInteraction {
  type: "permission";
  requestId: string | number;
  toolId: string;
  toolName: string;
}

interface QuestionInteraction {
  type: "question";
  requestId: string | number;
  itemId: string;
  questions: Array<OwnedQuestion & { id: string }>;
  index: number;
  answers: Record<string, { answers: string[] }>;
}

type Interaction = PermissionInteraction | QuestionInteraction;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
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

function parseVersion(output: string): string | null {
  return output.match(/\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+)\b/i)?.[1] ?? null;
}

const SUPPORTED_CODEX_VERSIONS = new Set(["0.142.5", "0.145.0"]);

/** Codex's own collaboration mode (`collaborationMode/list` advertises exactly
 *  `plan` and `default`) plus the permission axis. Plan is both: the collaboration
 *  mode is what makes the agent *plan*, and the read-only sandbox is the backstop
 *  that makes it structurally unable to write if it tries anyway.
 *
 *  Field names are load-bearing. Runtime updates take `sandboxPolicy` — an
 *  internally tagged object — while the plain-string `sandbox` field exists only
 *  on `thread/start`. Sending `sandbox` here returns `ok` with no notification and
 *  no change: silently ignored, measured on 0.145.0. */
const CODEX_MODE: Record<AgentMode, { collaboration: "plan" | "default"; sandbox: Record<string, unknown>; approval: string }> = {
  plan: { collaboration: "plan", sandbox: { type: "readOnly" }, approval: "on-request" },
  normal: { collaboration: "default", sandbox: { type: "workspaceWrite" }, approval: "on-request" },
  auto: { collaboration: "default", sandbox: { type: "workspaceWrite" }, approval: "never" },
};

/** Read Codex's confirmed settings back as a neutral mode. Order matters: a
 *  read-only sandbox outranks the approval policy, since it is the stronger
 *  constraint and the one Plan is defined by. */
function neutralMode(settings: Record<string, unknown>): AgentMode | null {
  const sandbox = isRecord(settings.sandboxPolicy) ? text(settings.sandboxPolicy.type) : "";
  const collaboration = isRecord(settings.collaborationMode) ? text(settings.collaborationMode.mode) : "";
  if (sandbox === "readOnly" || collaboration === "plan") return "plan";
  if (settings.approvalPolicy === "never") return "auto";
  if (!sandbox && !settings.approvalPolicy) return null;
  return "normal";
}

function normalizedAnswer(question: OwnedQuestion, answer: string): string[] {
  let value: unknown = answer;
  try {
    const parsed = JSON.parse(answer) as unknown;
    value = isRecord(parsed) ? Object.values(parsed)[0] : parsed;
  } catch {
    // Plain text remains the answer.
  }
  const submitted = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [typeof value === "string" ? value : answer];
  return submitted.map((item) =>
    question.options.find((option) => option.label.toLowerCase() === item.trim().toLowerCase())?.label ?? item,
  );
}

/** JSONL client for the explicitly schema-verified Codex app-server versions. */
export class CodexOwnedAgent implements OwnedAgent {
  readonly provider = "codex" as const;

  private child: ChildProcessWithoutNullStreams | null = null;
  private sink: OwnedAgentSink | null = null;
  private nextId: RequestId = 1;
  private pending = new Map<RequestId, PendingRpc>();
  private threadId = "";
  private turnId = "";
  private model = "";
  private currentMode: AgentMode = "normal";
  private active = false;
  private closing = false;
  private stderrTail = "";
  private tools = new Map<string, CodexTool>();
  private interaction: Interaction | null = null;
  private interactions: Interaction[] = [];
  private exitPromise: Promise<void> | null = null;

  constructor(
    readonly cwd: string,
    private readonly config: OwnedProviderConfig,
  ) {}

  async start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    this.sink = sink;
    const versionOutput = await this.probeVersion();
    const version = parseVersion(versionOutput);
    if (!version || !SUPPORTED_CODEX_VERSIONS.has(version)) {
      throw new Error(`Codex app-server version must be one of 0.142.5 or 0.145.0; found ${version ?? "an unknown version"}. Install a schema-verified CODEX_BIN version.`);
    }
    this.child = spawn(this.config.bin, ["app-server"], {
      cwd: this.cwd,
      env: this.config.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolve) => this.child!.once("exit", () => resolve()));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => this.fatal(`Codex app-server failed: ${error.message}`));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (!this.closing) this.fatal(error.message);
    });

    try {
      await withTimeout(this.waitForSpawn(), this.config.startupTimeoutMs, "Codex app-server spawn timed out.");
      await withTimeout(this.request("initialize", {
        clientInfo: { name: "even-better", title: "even-better", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }), this.config.startupTimeoutMs, "Codex app-server initialization timed out.");
      this.notify("initialized", {});
      const method = nativeSessionId ? "thread/resume" : "thread/start";
      const started = await withTimeout(this.request(method, {
        ...(nativeSessionId ? { threadId: nativeSessionId } : {}),
        cwd: this.cwd,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        ...(!nativeSessionId ? { ephemeral: false } : {}),
      }), this.config.startupTimeoutMs, nativeSessionId ? "Codex thread resume timed out." : "Codex thread creation timed out.");
      const thread = isRecord(started.thread) ? started.thread : null;
      if (!thread || typeof thread.id !== "string") throw new Error(`Codex returned an invalid ${method} response.`);
      this.threadId = thread.id;
      const model = text(started.model) || "Unknown";
      // thread/settings/update requires a full collaborationMode payload, and its
      // `settings.model` is mandatory — this is where that value comes from.
      this.model = text(started.model);
      sink.event({ type: "model", model });
      return { nativeSessionId: this.threadId, model };
    } catch (error) {
      await this.dispose();
      const detail = this.stderrTail.trim();
      throw new Error(`Codex could not start. Run codex once to verify authentication. ${error instanceof Error ? error.message : String(error)}${detail ? ` ${detail}` : ""}`);
    }
  }

  async prompt(prompt: string): Promise<void> {
    if (!this.child || !this.threadId) throw new Error("Codex session ended; create another session.");
    if (this.active) throw new Error("Codex is already processing a prompt.");
    this.active = true;
    this.turnId = "";
    this.tools.clear();
    try {
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
      });
      const turn = isRecord(response.turn) ? response.turn : null;
      if (!turn || typeof turn.id !== "string") throw new Error("Codex returned an invalid turn/start response.");
      this.turnId = turn.id;
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  /** `thread/settings/update` — a real runtime switch, confirmed by a
   *  `thread/settings/updated` notification (verified on 0.145.0). Errors reject:
   *  the thread is never restarted to force a mode, and the bridge reports the
   *  session as unable to switch rather than gating the provider. */
  async setMode(mode: AgentMode): Promise<void> {
    if (!this.child || !this.threadId) throw new Error("Codex session ended; create another session.");
    const target = CODEX_MODE[mode];
    const permissions = { approvalPolicy: target.approval, sandboxPolicy: target.sandbox };
    const collaboration = this.model
      ? { collaborationMode: { mode: target.collaboration, settings: { model: this.model } } }
      : {};
    try {
      await this.settingsUpdate({ ...permissions, ...collaboration });
    } catch (error) {
      // 0.142.5 is unverified for collaborationMode. The permission half is the part
      // that actually constrains the agent, so apply it alone rather than losing the
      // whole switch — and let a second failure surface as unavailable.
      if (!Object.keys(collaboration).length) throw error;
      await this.settingsUpdate(permissions);
    }
  }

  private async settingsUpdate(params: Record<string, unknown>): Promise<void> {
    await withTimeout(
      this.request("thread/settings/update", { threadId: this.threadId, ...params }).then(() => undefined),
      this.config.cancelTimeoutMs,
      "Codex did not acknowledge the mode change.",
    );
  }

  respondPermission(decision: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "permission") return Promise.reject(new Error("No matching Codex permission."));
    const normalized: OwnedPermissionDecision = decision === "allowAlways" ? "allowAlways" : decision === "allow" ? "allow" : "deny";
    this.respond(pending.requestId, {
      decision: normalized === "allowAlways" ? "acceptForSession" : normalized === "allow" ? "accept" : "decline",
    });
    this.advanceInteraction();
    return Promise.resolve();
  }

  respondQuestion(answer: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "question") return Promise.reject(new Error("No matching Codex question."));
    const question = pending.questions[pending.index];
    pending.answers[question.id] = { answers: normalizedAnswer(question, answer) };
    pending.index++;
    if (pending.index < pending.questions.length) {
      this.emitQuestion(pending);
      return Promise.resolve();
    }
    this.respond(pending.requestId, { answers: pending.answers });
    this.advanceInteraction();
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    this.cancelInteractions();
    if (!this.active || !this.threadId || !this.turnId) return;
    await withTimeout(
      this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).then(() => undefined),
      this.config.cancelTimeoutMs,
      "Codex did not acknowledge interruption.",
    );
  }

  async dispose(): Promise<void> {
    if (this.closing) {
      // Bounded: an unkillable child must not wedge a second dispose() caller.
      if (this.exitPromise) {
        await withTimeout(this.exitPromise, this.config.shutdownTimeoutMs, "Codex shutdown timed out.").catch(
          () => undefined,
        );
      }
      return;
    }
    this.closing = true;
    try {
      this.cancelInteractions();
    } catch {
      // Writing a cancellation to a dead stdin throws; teardown continues.
    }
    if (this.active && this.threadId && this.turnId) {
      try {
        await withTimeout(
          this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).then(() => undefined),
          this.config.cancelTimeoutMs,
          "Codex cancellation timed out.",
        );
      } catch {
        // Continue through bounded process teardown.
      }
    }
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    try {
      await withTimeout(this.exitPromise ?? Promise.resolve(), this.config.shutdownTimeoutMs, "Codex EOF shutdown timed out.");
    } catch {
      this.signalChild("SIGTERM");
      try {
        await withTimeout(this.exitPromise ?? Promise.resolve(), this.config.shutdownTimeoutMs, "Codex TERM shutdown timed out.");
      } catch {
        this.signalChild("SIGKILL");
        // Bounded like every step above it. An unkillable child would otherwise
        // hang dispose() -> catalog.dispose() -> teardown() forever.
        if (this.exitPromise) {
          try {
            await withTimeout(this.exitPromise, this.config.shutdownTimeoutMs, "Codex KILL shutdown timed out.");
          } catch {
            console.warn(`[codex] child ${child.pid ?? "?"} did not exit after SIGKILL`);
          }
        }
      }
    }
    this.child = null;
  }

  private async probeVersion(): Promise<string> {
    const child = spawn(this.config.bin, ["--version"], {
      cwd: this.cwd,
      env: this.config.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    await withTimeout(new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Codex version probe exited with code ${code ?? "unknown"}.`)));
    }), this.config.startupTimeoutMs, "Codex version probe timed out.").catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    return output;
  }

  private waitForSpawn(): Promise<void> {
    if (!this.child) return Promise.reject(new Error("Codex child was not created."));
    if (this.child.pid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.child!.once("spawn", resolve);
      this.child!.once("error", reject);
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private respond(id: string | number, result: Record<string, unknown>): void {
    this.write({ id, result });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server input is closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fatal("Codex app-server sent invalid JSONL data.");
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isRecord(message.error)) pending.reject(new Error(text(message.error.message) || "Codex request failed."));
      else pending.resolve(isRecord(message.result) ? message.result : {});
      return;
    }
    if (typeof message.method !== "string" || !isRecord(message.params)) return;
    if ((typeof message.id === "number" || typeof message.id === "string")) {
      this.onServerRequest(message.method, message.id, message.params);
    } else {
      this.onNotification(message.method, message.params);
    }
  }

  private onServerRequest(method: string, requestId: string | number, params: Record<string, unknown>): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const itemId = text(params.itemId);
      const tool = this.tools.get(itemId);
      const command = text(params.command);
      const reason = text(params.reason);
      const cwd = text(params.cwd);
      this.enqueueInteraction({
        type: "permission",
        requestId,
        toolId: itemId,
        toolName: tool?.name ?? (method.includes("commandExecution") ? "Shell command" : "File change"),
      }, reason || command || cwd || "Codex needs approval to continue.");
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const questions: QuestionInteraction["questions"] = [];
      if (Array.isArray(params.questions)) {
        for (const raw of params.questions) {
          if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.question !== "string") continue;
          const options = Array.isArray(raw.options) ? raw.options.flatMap((option) => {
            if (!isRecord(option) || typeof option.label !== "string") return [];
            return [{ label: option.label, description: text(option.description) }];
          }) : [];
          questions.push({
            id: raw.id,
            question: raw.question,
            header: text(raw.header) || "Codex",
            options,
            multiSelect: false,
          });
        }
      }
      if (!questions.length) {
        this.respond(requestId, { answers: {} });
        return;
      }
      this.enqueueInteraction({
        type: "question",
        requestId,
        itemId: text(params.itemId),
        questions,
        index: 0,
        answers: {},
      });
      return;
    }
    this.respond(requestId, {});
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (!this.sink) return;
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      this.turnId = params.turn.id;
      return;
    }
    if (method === "thread/settings/updated" && isRecord(params.threadSettings)) {
      // Provider truth for the mode marker: emitted after Codex applies a change,
      // so it also carries changes we did not make.
      const settings = params.threadSettings;
      const model = text(settings.model);
      if (model) this.model = model;
      const mode = neutralMode(settings);
      if (mode && mode !== this.currentMode) {
        this.currentMode = mode;
        this.sink.event({ type: "mode", mode });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.sink.event({ type: "prose", text: text(params.delta) });
      return;
    }
    if (method === "item/started" && isRecord(params.item)) {
      this.startTool(params.item);
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = text(params.itemId);
      const tool = this.tools.get(itemId);
      if (tool) tool.output += text(params.delta);
      return;
    }
    if (method === "item/completed" && isRecord(params.item)) {
      this.completeTool(params.item);
      return;
    }
    if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const entries = params.plan.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.step !== "string") return [];
        const status: "completed" | "in_progress" | "pending" =
          entry.status === "completed" ? "completed" : entry.status === "inProgress" ? "in_progress" : "pending";
        return [{ content: entry.step, status }];
      });
      this.sink.event({ type: "plan", entries });
      return;
    }
    if (method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last)) {
      const usage = params.tokenUsage.last;
      this.sink.event({
        type: "usage",
        usage: {
          inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
          turns: 1,
        },
      });
      return;
    }
    if (method === "turn/completed" && isRecord(params.turn)) {
      this.active = false;
      this.turnId = "";
      this.cancelInteractions(false);
      const status = text(params.turn.status);
      const error = isRecord(params.turn.error) ? text(params.turn.error.message) : "";
      this.sink.event({
        type: "result",
        success: status === "completed",
        cancelled: status === "interrupted",
        text: error || (status === "interrupted" ? "Interrupted." : status === "failed" ? "Codex could not complete the turn." : undefined),
      });
      return;
    }
    if (method === "error" && isRecord(params.error)) {
      this.sink.event({ type: "notification", title: "Codex error", message: text(params.error.message) || "Codex reported an error." });
    }
  }

  private startTool(item: Record<string, unknown>): void {
    if (!this.sink || typeof item.id !== "string") return;
    let name = "Codex tool";
    let input: unknown = {};
    switch (item.type) {
      case "commandExecution":
        name = "Shell command";
        input = { command: text(item.command), cwd: text(item.cwd) };
        break;
      case "fileChange":
        name = "File change";
        input = item.changes;
        break;
      case "mcpToolCall":
        name = `${text(item.server)} · ${text(item.tool)}`;
        input = item.arguments;
        break;
      case "dynamicToolCall":
        name = text(item.tool) || "Dynamic tool";
        input = item.arguments;
        break;
      case "webSearch":
        name = "Web search";
        input = { query: text(item.query) };
        break;
      case "imageView":
        name = "View image";
        input = { path: text(item.path) };
        break;
      default:
        return;
    }
    this.tools.set(item.id, { name, input, output: "" });
    this.sink.event({ type: "tool", id: item.id, name, status: "running", input });
  }

  private completeTool(item: Record<string, unknown>): void {
    if (!this.sink || typeof item.id !== "string") return;
    const tool = this.tools.get(item.id);
    if (!tool) return;
    const status = item.status === "failed" || item.status === "declined" ? "failed" : "completed";
    const output = text(item.aggregatedOutput)
      || readable(item.result)
      || readable(item.error)
      || (item.type === "fileChange" ? readable(item.changes) : tool.output);
    this.sink.event({ type: "tool", id: item.id, name: tool.name, status, input: tool.input, output });
  }

  private enqueueInteraction(interaction: Interaction, description = ""): void {
    if (this.interaction) {
      this.interactions.push(interaction);
      return;
    }
    this.interaction = interaction;
    if (interaction.type === "permission") {
      this.sink?.event({
        type: "permission",
        id: `codex-permission:${Date.now()}`,
        toolId: interaction.toolId,
        toolName: interaction.toolName,
        description,
        options: [
          { key: "allow", label: "Allow once" },
          { key: "allowAlways", label: "Allow for session" },
          { key: "deny", label: "Deny" },
        ],
      });
    } else {
      this.emitQuestion(interaction);
    }
  }

  private emitQuestion(interaction: QuestionInteraction): void {
    this.sink?.event({
      type: "question",
      id: interaction.itemId,
      question: interaction.questions[interaction.index],
      index: interaction.index,
      total: interaction.questions.length,
    });
  }

  private advanceInteraction(): void {
    this.interaction = null;
    const next = this.interactions.shift();
    if (next) this.enqueueInteraction(next);
  }

  private cancelInteractions(respond = true): void {
    const all = [this.interaction, ...this.interactions].filter((value): value is Interaction => value !== null);
    this.interaction = null;
    this.interactions = [];
    if (!respond) return;
    for (const interaction of all) {
      if (interaction.type === "permission") this.respond(interaction.requestId, { decision: "cancel" });
      else this.respond(interaction.requestId, { answers: {} });
    }
  }

  private signalChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The validated child may already have exited between the checks and signal.
    }
  }

  private fatal(message: string): void {
    this.sink?.event({ type: "fatal", message });
  }
}
