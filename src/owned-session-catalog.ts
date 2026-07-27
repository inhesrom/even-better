import { randomUUID } from "node:crypto";
import path from "node:path";
import { ClaudeOwnedAgent } from "./claude-owned-agent.js";
import { CodexOwnedAgent } from "./codex-owned-agent.js";
import { GrokOwnedAgent } from "./grok-owned-agent.js";
import type { GrokConfig } from "./grok-config.js";
import type { OwnedAgent, OwnedAgentStartInfo } from "./owned-agent.js";
import { parseAnswer } from "./owned-commands.js";
import type { OwnedConfig, OwnedProviderConfig } from "./owned-config.js";
import { OwnedSessionBridge } from "./owned-session-bridge.js";
import {
  OwnedSessionStore,
  OwnedSessionStoreError,
  type RememberedSessionMetadata,
} from "./owned-session-store.js";
import { WorkspaceConfigError } from "./owned-workspaces.js";
import {
  SessionControlError,
  type LiveSession,
  type ProviderId,
  type SessionCatalog,
  type SessionDescriptor,
  type SessionHistoryEntry,
  type SessionState,
} from "./session.js";
import { dropSession, emit } from "./sse.js";

type AgentFactory = (provider: ProviderId, cwd: string, config: OwnedProviderConfig) => OwnedAgent;

function defaultAgentFactory(provider: ProviderId, cwd: string, config: OwnedProviderConfig): OwnedAgent {
  if (provider === "claude") return new ClaudeOwnedAgent(cwd, config);
  if (provider === "codex") return new CodexOwnedAgent(cwd, config);
  const grok: GrokConfig = {
    bin: config.bin,
    cwd,
    env: config.env,
    startupTimeoutMs: config.startupTimeoutMs,
    cancelTimeoutMs: config.cancelTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
  return new GrokOwnedAgent(grok);
}

function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok";
}

function compactPrompt(prompt: string, limit = 56): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const points = [...normalized];
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : normalized;
}

/** The prime that makes the stock app render the wizard's first question.
 *
 *  ADR 0004 measured that the app ignored a `user_question` emitted when a
 *  server-authored row opened, and concluded such rows could not host a menu.
 *  ADR 0005 measured *why*: the question must not arrive in the same tick as the
 *  stream opening, and the stream must first carry something that looks like a
 *  turn. A `user_prompt` followed by the question one delay later renders and is
 *  answerable on a physical phone; the same payload sent synchronously is dropped.
 *
 *  Only the first question needs this. Answers emit their follow-up question
 *  synchronously and the app renders those fine. */
const SETUP_PRIME_TEXT = "New agent session";

/** Which wizard question is outstanding. Tracked explicitly because the retry step
 *  keeps both earlier answers, so "which question is this" can no longer be inferred
 *  from whether `selectedProvider` is set. */
type SetupStep = "provider" | "directory" | "retry";

const RETRY_AGAIN = "Retry";
const RETRY_DIRECTORY = "Change directory";
const RETRY_AGENT = "Change agent";

interface SetupState {
  step: SetupStep;
  selectedProvider: ProviderId | null;
  selectedCwd: string | null;
  displayedDirectories: string[];
  pendingWire: object;
  firstPrompt: string | null;
  starting: boolean;
  failures: number;
}

function freshSetup(): SetupState {
  return {
    step: "provider",
    selectedProvider: null,
    selectedCwd: null,
    displayedDirectories: [],
    pendingWire: {},
    firstPrompt: null,
    starting: false,
    failures: 0,
  };
}

/** The concurrency cap, distinguishable from any other startup failure without
 *  matching on message text. */
class OwnedProcessLimitError extends SessionControlError {}

class OwnedCatalogSession implements LiveSession {
  readonly provider = "codex" as const;
  private bridge: OwnedSessionBridge | null = null;
  /** Held only while `start()` is in flight — see `detach()`. Deliberately not `bridge`,
   *  which `ensureAttached` hands out and would then return before it is usable. */
  private startingBridge: OwnedSessionBridge | null = null;
  private releaseLease: (() => void) | null = null;
  private attachPromise: Promise<OwnedSessionBridge> | null = null;
  private setup: SetupState | null;
  private questionTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly createdAt = new Date().toISOString();

  constructor(
    readonly id: string,
    private readonly catalog: OwnedSessionCatalog,
    private record: RememberedSessionMetadata | null = null,
  ) {
    this.setup = record ? null : freshSetup();
    if (this.setup) this.askProvider(false);
  }

  get agentProvider(): ProviderId | undefined {
    return this.record?.agentProvider;
  }

  get cwd(): string {
    return this.record?.cwd ?? "";
  }

  get state(): SessionState {
    // Mid-launch there is no menu to answer, so reporting "awaiting" would leave the
    // glasses waiting on input that does not exist.
    if (this.setup) return this.setup.starting ? "busy" : "awaiting";
    return this.bridge?.state ?? "idle";
  }

  get isAttached(): boolean {
    return this.bridge !== null;
  }

  get hasLease(): boolean {
    return this.releaseLease !== null;
  }

  /** A setup session still in the wizard: no provider started, none starting. */
  get isPendingSetup(): boolean {
    return this.setup !== null && !this.setup.starting;
  }

  get isIdleAttached(): boolean {
    return this.bridge?.state === "idle" && !this.attachPromise;
  }

  get lastUsedMs(): number {
    return this.record ? Date.parse(this.record.lastUsedAt) : Number.MAX_SAFE_INTEGER;
  }

  describe(): Promise<SessionDescriptor> {
    if (!this.record) {
      return Promise.resolve({
        id: this.id,
        title: this.setupTitle(),
        timestamp: this.createdAt,
        cwd: "",
        provider: "codex",
        status: this.state,
        model: "Unknown",
      });
    }
    const prompt = this.record.firstPrompt ? compactPrompt(this.record.firstPrompt) : "";
    return Promise.resolve({
      id: this.id,
      title: `${providerLabel(this.record.agentProvider)} · ${path.basename(this.record.cwd || "/")}${prompt ? ` · ${prompt}` : ""}`,
      timestamp: this.record.lastUsedAt,
      cwd: this.record.cwd,
      provider: "codex",
      agentProvider: this.record.agentProvider,
      status: this.state,
      model: this.record.model,
    });
  }

  /** The launcher and a wizard already under way must not read alike on the
   *  glasses: the list shows both while one is starting. */
  private setupTitle(): string {
    const setup = this.setup;
    if (!setup) return "Setting up agent session…";
    if (setup.starting) {
      const provider = setup.selectedProvider ? providerLabel(setup.selectedProvider) : "agent";
      return `Starting ${provider} · ${path.basename(setup.selectedCwd || "/")}…`;
    }
    if (setup.firstPrompt !== null) return `Setting up · ${compactPrompt(setup.firstPrompt)}`;
    return "＋ Agent setup";
  }

  async prompt(text: string): Promise<void> {
    if (this.setup) {
      if (this.setup.firstPrompt !== null) {
        throw new SessionControlError(
          "The first prompt is waiting for setup; finish choosing an agent and directory before sending another prompt.",
          409,
        );
      }
      this.setup.firstPrompt = text;
      return;
    }
    const bridge = await this.ensureAttached(true);
    const now = new Date().toISOString();
    if (!this.record!.firstPrompt) this.record!.firstPrompt = text;
    this.catalog.store.appendHistory(this.id, { role: "user", text, timestamp: now });
    this.touch(now);
    await bridge.prompt(text);
  }

  async respondPermission(decision: string): Promise<void> {
    if (!this.bridge) throw new SessionControlError("No attached agent permission request is pending.", 409);
    await this.bridge.respondPermission(decision);
  }

  async respondQuestion(answer: string): Promise<void> {
    if (!this.setup) {
      if (!this.bridge) throw new SessionControlError("No attached agent question is pending.", 409);
      await this.bridge.respondQuestion(answer);
      return;
    }
    if (this.setup.starting) throw new SessionControlError("The selected agent is still starting.", 409);
    const value = parseAnswer(answer).trim();
    switch (this.setup.step) {
      case "provider":
        this.answerProvider(value);
        return;
      case "directory":
        this.answerDirectory(value);
        return;
      case "retry":
        this.answerRetry(value);
        return;
      default: {
        const unreachable: never = this.setup.step;
        throw new Error(`Unhandled setup step: ${String(unreachable)}`);
      }
    }
  }

  async interrupt(): Promise<void> {
    await this.bridge?.interrupt();
  }

  async onConnect(): Promise<void> {
    if (this.setup) {
      // Mid-launch there is no answerable question: re-priming one would put a menu on
      // the glasses whose response is rejected with 409 until startup settles. Say what
      // is happening instead — a blank session is what makes people re-tap ＋ New Session.
      if (this.setup.starting) {
        const provider = this.setup.selectedProvider;
        if (provider) this.notify(`Starting ${providerLabel(provider)}…`, "The agent is still starting.");
        return;
      }
      // See SETUP_PRIME_TEXT: without this the app drops the question that
      // replayPending() is about to schedule.
      emit(this.id, { type: "user_prompt", text: SETUP_PRIME_TEXT });
      // Exhaustive on purpose: an if/else chain mapped every unlisted step to the
      // retry menu, so a new step would silently replay the wrong question.
      switch (this.setup.step) {
        case "provider":
          this.askProvider(false);
          return;
        case "directory":
          this.askDirectory(false);
          return;
        case "retry":
          this.askRetry(false);
          return;
        default: {
          const unreachable: never = this.setup.step;
          throw new Error(`Unhandled setup step: ${String(unreachable)}`);
        }
      }
    }
    try {
      await this.ensureAttached(false);
    } catch {
      // ensureAttached already emits the actionable notification for SSE entry.
      return;
    }
    // `notification` is append-only and the app never replays, so the readiness line
    // is gone after a reconnect. `firstPrompt` doubles as "has this session ever run
    // a prompt", so this stops announcing the moment a real one lands.
    if (this.record && !this.record.firstPrompt) {
      this.announceReady(this.record.agentProvider, this.record.cwd);
    }
  }

  history(): Promise<SessionHistoryEntry[]> {
    if (!this.record) return Promise.resolve([]);
    return Promise.resolve(this.catalog.store.history(this.id).map(({ role, text }) => ({ role, text })));
  }

  replayPending(): void {
    if (this.setup) {
      if (this.setup.starting) return;
      const wire = this.setup.pendingWire;
      // Deferred, not synchronous: see SETUP_PRIME_TEXT. index.ts pushes its status
      // snapshot between the prime and this, which is the order measured to work.
      clearTimeout(this.questionTimer ?? undefined);
      this.questionTimer = setTimeout(() => {
        this.questionTimer = null;
        if (this.setup && !this.setup.starting) emit(this.id, wire);
      }, this.catalog.config.setupQuestionDelayMs);
      // A wizard nobody answers must not be why the process cannot exit.
      this.questionTimer.unref();
      return;
    }
    this.bridge?.replayPending();
  }

  /** Restart the wizard on this same public id. A fresh null-session prompt used to
   *  dispose the pending setup instead, and dispose() ends its SSE stream — so a
   *  duplicate or late ＋ New Session prompt silently killed the wizard the phone was
   *  showing. Keeping the id keeps that stream, and the app adopts the id we return. */
  restartSetup(): void {
    this.setup = freshSetup();
    this.askProvider(true);
  }

  async detach(): Promise<void> {
    // `startingBridge` covers the window before `installAttached`: a bridge is installed
    // only once `start()` resolves, so a teardown landing mid-spawn would otherwise find
    // nothing to dispose and orphan the child — which is detached for codex and grok, so
    // it outlives the server.
    const bridge = this.bridge ?? this.startingBridge;
    this.bridge = null;
    this.startingBridge = null;
    if (bridge) await bridge.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = null;
    // The lease must be released even when the provider teardown throws (a
    // Grok process group that will not reap does), or shutdown leaves a live
    // lease.json behind and the session is unattachable until it goes stale.
    try {
      await this.detach();
    } finally {
      this.releaseCatalogLease();
      // Terminal for this public id (shutdown, or an abandoned setup evicted by
      // createSetup) — detach alone must NOT drop it, since a remembered session
      // keeps its id and re-attaches later.
      dropSession(this.id);
    }
  }

  installAttached(bridge: OwnedSessionBridge): void {
    this.bridge = bridge;
  }

  installStarting(bridge: OwnedSessionBridge | null): void {
    this.startingBridge = bridge;
  }

  installLease(releaseLease: () => void): void {
    this.releaseLease = releaseLease;
  }

  releaseCatalogLease(): void {
    this.releaseLease?.();
    this.releaseLease = null;
  }

  onModel(model: string): void {
    if (!this.record || !model) return;
    this.record.model = model;
    this.save(true);
  }

  onAssistant(text: string): void {
    if (!this.record || !text.trim()) return;
    this.catalog.store.appendHistory(this.id, {
      role: "assistant",
      text: text.trim(),
      timestamp: new Date().toISOString(),
    });
  }

  onUnavailable(bridge: OwnedSessionBridge): void {
    if (this.bridge !== bridge) return;
    void this.detach().catch(() => undefined);
  }

  touch(at: string = new Date().toISOString()): void {
    if (!this.record) return;
    this.record.lastUsedAt = at;
    this.catalog.config.workspaces.touch(this.record.cwd, Date.parse(at));
    this.save(true);
  }

  private async ensureAttached(forPrompt: boolean): Promise<OwnedSessionBridge> {
    if (this.bridge) {
      this.touch();
      return this.bridge;
    }
    if (this.attachPromise) return this.attachPromise;
    const record = this.record!;
    this.attachPromise = this.catalog.attach(this, record.agentProvider, record.cwd, record.nativeSessionId)
      .then(({ bridge, nativeSessionId, model }) => {
        record.nativeSessionId = nativeSessionId;
        record.model = model || record.model;
        this.touch();
        return bridge;
      })
      .catch(async (error) => {
        await this.detach().catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        this.notify(`${providerLabel(record.agentProvider)} session could not resume`, `${detail} The remembered session and local history were kept; verify the CLI and try opening it again.`);
        throw new SessionControlError(detail, 503);
      })
      .finally(() => {
        this.attachPromise = null;
      });
    try {
      return await this.attachPromise;
    } catch (error) {
      if (forPrompt) throw error;
      throw error;
    }
  }

  private answerProvider(value: string): void {
    const setup = this.setup!;
    const selected = (Object.keys(this.catalog.config.providers) as ProviderId[]).find(
      (provider) => providerLabel(provider).toLowerCase() === value.toLowerCase(),
    );
    if (!selected) {
      this.notify("Choose an agent", "Select one of the available agents shown below.");
      this.askProvider(true);
      return;
    }
    emit(this.id, { type: "question_answer", answers: { answer: providerLabel(selected) } });
    setup.selectedProvider = selected;
    this.askDirectory(true);
  }

  private answerDirectory(value: string): void {
    const setup = this.setup!;
    let cwd: string;
    try {
      cwd = this.catalog.config.workspaces.resolve(value, setup.displayedDirectories);
    } catch (error) {
      const message = error instanceof WorkspaceConfigError ? error.message : "Choose an eligible working directory.";
      this.notify("Invalid directory", message);
      this.askDirectory(true);
      return;
    }
    emit(this.id, { type: "question_answer", answers: { answer: cwd } });
    this.beginLaunch(setup.selectedProvider!, cwd);
  }

  private answerRetry(value: string): void {
    const setup = this.setup!;
    const choice = value.toLowerCase();
    if (choice === RETRY_AGENT.toLowerCase()) {
      emit(this.id, { type: "question_answer", answers: { answer: RETRY_AGENT } });
      setup.selectedProvider = null;
      setup.selectedCwd = null;
      this.askProvider(true);
      return;
    }
    if (choice === RETRY_DIRECTORY.toLowerCase()) {
      emit(this.id, { type: "question_answer", answers: { answer: RETRY_DIRECTORY } });
      setup.selectedCwd = null;
      this.askDirectory(true);
      return;
    }
    // Both earlier answers are still on the state, so a transient failure costs one
    // tap instead of re-answering the whole wizard — that re-ask was the loop the
    // glasses got stuck in when a provider kept timing out.
    if (choice === RETRY_AGAIN.toLowerCase() && setup.selectedProvider && setup.selectedCwd) {
      emit(this.id, { type: "question_answer", answers: { answer: RETRY_AGAIN } });
      this.beginLaunch(setup.selectedProvider, setup.selectedCwd);
      return;
    }
    this.notify("Choose an option", "Retry the last attempt, or change the directory or agent.");
    this.askRetry(true);
  }

  private askProvider(send: boolean): void {
    this.setup!.step = "provider";
    const providers = Object.keys(this.catalog.config.providers) as ProviderId[];
    const wire = {
      type: "user_question",
      questions: [{
        question: "Which coding agent should this session use?",
        header: "Agent",
        options: providers.map((provider) => ({
          label: providerLabel(provider),
          description: `Start or resume a ${providerLabel(provider)} session.`,
        })),
      }],
      toolUseId: `owned-setup:${this.id}:provider`,
    };
    this.setup!.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  private askDirectory(send: boolean): void {
    this.setup!.step = "directory";
    this.setup!.displayedDirectories = this.catalog.config.workspaces.choices(
      this.catalog.config.directoryLimit || undefined,
    );
    const wire = {
      type: "user_question",
      questions: [{
        question: `Which working directory should ${providerLabel(this.setup!.selectedProvider!)} use? You can also enter any eligible descendant path.`,
        header: "Directory",
        options: this.setup!.displayedDirectories.map((directory) => ({
          label: directory,
          description: "Use this directory for the entire session.",
        })),
      }],
      toolUseId: `owned-setup:${this.id}:directory`,
    };
    this.setup!.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  private askRetry(send: boolean): void {
    const setup = this.setup!;
    setup.step = "retry";
    const target = setup.selectedProvider && setup.selectedCwd
      ? `${providerLabel(setup.selectedProvider)} · ${path.basename(setup.selectedCwd || "/")}`
      : "the last attempt";
    const wire = {
      type: "user_question",
      questions: [{
        question: `Retry ${target}?`,
        header: "Retry",
        options: [
          { label: RETRY_AGAIN, description: `Start ${target} again.` },
          { label: RETRY_DIRECTORY, description: "Pick a different working directory." },
          { label: RETRY_AGENT, description: "Pick a different coding agent." },
        ],
      }],
      toolUseId: `owned-setup:${this.id}:retry`,
    };
    setup.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  /** Startup takes seconds to tens of seconds; awaiting it would hold the phone's
   *  question-response POST open for the whole time. launch() reports every outcome
   *  over SSE, so the HTTP call returns as soon as the answer is accepted. */
  private beginLaunch(provider: ProviderId, cwd: string): void {
    void this.launch(provider, cwd).catch((error) => {
      this.notify(`${providerLabel(provider)} could not start`, error instanceof Error ? error.message : String(error));
    });
  }

  private async launch(provider: ProviderId, cwd: string): Promise<void> {
    const setup = this.setup!;
    // The wizard now runs ahead of the real prompt, so finishing with nothing to
    // dispatch is the ordinary case: the session lands idle and asks for one.
    const firstPrompt = setup.firstPrompt;
    setup.starting = true;
    setup.selectedProvider = provider;
    setup.selectedCwd = cwd;
    // Otherwise the glasses see nothing at all between the directory answer and the
    // result — tens of seconds of silence that reads as a hung session.
    this.notify(`Starting ${providerLabel(provider)}…`, `Opening ${providerLabel(provider)} in ${path.basename(cwd || "/")}.`);
    let attached: { bridge: OwnedSessionBridge; nativeSessionId: string; model: string };
    let now: string;
    try {
      attached = await this.catalog.attach(this, provider, cwd);
      now = new Date().toISOString();
      const record: RememberedSessionMetadata = {
        version: 1,
        id: this.id,
        agentProvider: provider,
        cwd,
        nativeSessionId: attached.nativeSessionId,
        model: attached.model || "Unknown",
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        // Only a prompt that actually runs is the session's first prompt. Leaving it
        // unset keeps the row titled `Claude · dir` until prompt() fills it with the
        // first spoken one, so the title never reads back a launch gesture.
        ...(firstPrompt !== null ? { firstPrompt } : {}),
      };
      this.catalog.store.save(record);
      this.record = record;
      this.setup = null;
      this.catalog.config.workspaces.touch(cwd, Date.parse(now));
      emit(this.id, {
        type: "status",
        state: "idle",
        sessionId: this.id,
        provider: "codex",
        agentProvider: provider,
      });
    } catch (error) {
      await this.detach().catch(() => undefined);
      this.releaseCatalogLease();
      setup.starting = false;
      setup.failures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      this.notify(
        error instanceof OwnedProcessLimitError
          ? "Agent process limit reached"
          : `${providerLabel(provider)} could not start`,
        setup.failures > 1 ? `${detail} (attempt ${setup.failures})` : detail,
      );
      // Both answers survive and the wizard now advances only on a deliberate tap, so
      // a provider that keeps failing can no longer walk the glasses through the whole
      // agent + directory sequence over and over.
      this.askRetry(true);
      return;
    }

    if (firstPrompt === null) {
      this.announceReady(provider, cwd);
      return;
    }

    try {
      this.catalog.store.appendHistory(this.id, { role: "user", text: firstPrompt, timestamp: now });
      await attached.bridge.prompt(firstPrompt);
    } catch (error) {
      // Already promoted, so the wizard is gone: a notification is the only surface
      // left for a retained first prompt that never ran.
      this.notify(
        `${providerLabel(provider)} did not run the first prompt`,
        `${error instanceof Error ? error.message : String(error)} Send it again from the glasses.`,
      );
    }
  }

  private save(updateTimestamp: boolean): void {
    if (!this.record) return;
    if (updateTimestamp) this.record.updatedAt = new Date().toISOString();
    this.catalog.store.save(this.record);
  }

  /** The human-readable half of "this session accepts input"; `status: idle` is
   *  already on the wire. Without it a started-but-unprompted session is
   *  indistinguishable from a blank one, and a blank session is what makes people
   *  re-tap ＋ New Session. */
  private announceReady(provider: ProviderId, cwd: string): void {
    this.notify(
      "Ready — say your prompt",
      `${providerLabel(provider)} is running in ${path.basename(cwd || "/")}. Say your first prompt now.`,
    );
  }

  private notify(title: string, message: string): void {
    emit(this.id, { type: "notification", title, message });
  }
}

/** Durable owned-session catalog with prompt-triggered transient setup sessions. */
export class OwnedSessionCatalog implements SessionCatalog {
  readonly store: OwnedSessionStore;
  private readonly sessions = new Map<string, OwnedCatalogSession>();
  private disposed = false;
  private attachmentTail: Promise<void> = Promise.resolve();

  constructor(
    readonly config: OwnedConfig,
    private readonly factory: AgentFactory = defaultAgentFactory,
    store: OwnedSessionStore = new OwnedSessionStore(config.homeDir),
  ) {
    this.store = store;
    for (const record of store.list()) {
      if (!config.workspaces.isEligible(record.cwd)) continue;
      const session = new OwnedCatalogSession(record.id, this, record);
      this.sessions.set(record.id, session);
      try {
        session.installLease(store.acquireLease(record.id));
      } catch {
        // Another server can own the row; opening it will report that lease.
      }
      config.workspaces.touch(record.cwd, Date.parse(record.lastUsedAt));
    }
  }

  async list(): Promise<SessionDescriptor[]> {
    this.ensureLauncher();
    const sessions = [...this.sessions.values()];
    sessions.sort((a, b) => {
      if (a.agentProvider === undefined && b.agentProvider !== undefined) return -1;
      if (a.agentProvider !== undefined && b.agentProvider === undefined) return 1;
      return b.lastUsedMs - a.lastUsedMs;
    });
    return Promise.all(sessions.map((session) => session.describe()));
  }

  get(id: string): Promise<LiveSession | undefined> {
    return Promise.resolve(this.sessions.get(id));
  }

  async default(): Promise<LiveSession | undefined> {
    if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
    return this.createSetup();
  }

  info(): Promise<{ provider: "codex"; model: string }> {
    return Promise.resolve({ provider: "codex", model: "Unknown" });
  }

  attach(
    session: OwnedCatalogSession,
    provider: ProviderId,
    cwd: string,
    nativeSessionId?: string,
  ): Promise<{ bridge: OwnedSessionBridge; nativeSessionId: string; model: string }> {
    const run = this.attachmentTail.then(() => this.attachNow(session, provider, cwd, nativeSessionId));
    this.attachmentTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((session) => session.dispose()));
  }

  /** Keep exactly one openable wizard row in the list. This is the whole point of the
   *  reordering: it is reachable before any prompt exists, so agent and directory are
   *  chosen first. One at a time — a wizard already under way is that row, and only a
   *  setup that has begun starting a provider frees the slot for the next one. */
  private ensureLauncher(): void {
    if (this.disposed) return;
    if ([...this.sessions.values()].some((session) => session.isPendingSetup)) return;
    const session = new OwnedCatalogSession(`owned:${randomUUID()}`, this);
    this.sessions.set(session.id, session);
  }

  private createSetup(): OwnedCatalogSession {
    // At most one setup is ever in flight: the stock app renders a single
    // ＋ New Session row, and the wizard state lives on the session its first prompt
    // created. A fresh null-session prompt means the user restarted the flow, so the
    // pending setup is reused rather than replaced. Disposing it instead ended its SSE
    // stream (res.end(), with no notification first), so a duplicate or late prompt
    // killed the wizard the phone had open. Reuse also keeps setups from accumulating
    // — they sort first in list(), so leaking them fills the top of the phone's list.
    // In practice this reuses the ＋ Agent setup row ensureLauncher() keeps around.
    // A setup already mid-launch is left alone: it owns a spawning child and the
    // user's retained prompt. If that launch fails it becomes pending again, and the
    // next restart reuses it.
    for (const existing of this.sessions.values()) {
      if (!existing.isPendingSetup) continue;
      existing.restartSetup();
      return existing;
    }
    const session = new OwnedCatalogSession(`owned:${randomUUID()}`, this);
    this.sessions.set(session.id, session);
    return session;
  }

  private async attachNow(
    session: OwnedCatalogSession,
    provider: ProviderId,
    cwd: string,
    nativeSessionId?: string,
  ): Promise<{ bridge: OwnedSessionBridge; nativeSessionId: string; model: string }> {
    if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
    const providerConfig = this.config.providers[provider];
    if (!providerConfig) {
      throw new SessionControlError(`${providerLabel(provider)} is unavailable. Install it or set its *_BIN path, then restart even-better.`, 503);
    }
    let releaseLease: (() => void) | null = null;
    let acquiredLease = false;
    let bridge: OwnedSessionBridge | null = null;
    try {
      if (!session.hasLease) {
        releaseLease = this.store.acquireLease(session.id);
        session.installLease(releaseLease);
        releaseLease = null;
        acquiredLease = true;
      }
      const attached = [...this.sessions.values()].filter((candidate) => candidate.isAttached && candidate !== session);
      if (attached.length >= this.config.maxSessions) {
        const victim = attached.filter((candidate) => candidate.isIdleAttached).sort((a, b) => a.lastUsedMs - b.lastUsedMs)[0];
        if (!victim) {
          throw new OwnedProcessLimitError(
            `Owned agent process limit reached (${this.config.maxSessions}); all attached sessions are busy or awaiting input. Finish or interrupt one, then retry.`,
            409,
          );
        }
        await victim.detach();
      }
      const agent = this.factory(provider, cwd, providerConfig);
      bridge = new OwnedSessionBridge(session.id, agent, {
        model: (model) => session.onModel(model),
        assistant: (text) => session.onAssistant(text),
        activity: () => session.touch(),
        unavailable: () => {
          if (bridge) session.onUnavailable(bridge);
        },
      });
      session.installStarting(bridge);
      let info: OwnedAgentStartInfo;
      try {
        info = await bridge.start(nativeSessionId);
      } finally {
        session.installStarting(null);
      }
      // Teardown can land while the child is spawning. Promoting onto a disposed session
      // would write metadata after shutdown and leave a live, unowned bridge behind.
      if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
      session.installAttached(bridge);
      return { bridge, nativeSessionId: info.nativeSessionId, model: info.model };
    } catch (error) {
      await bridge?.dispose().catch(() => undefined);
      releaseLease?.();
      if (acquiredLease) session.releaseCatalogLease();
      if (error instanceof OwnedSessionStoreError) throw new SessionControlError(error.message, 409);
      throw error;
    }
  }
}
