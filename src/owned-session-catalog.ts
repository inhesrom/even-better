import { randomUUID } from "node:crypto";
import path from "node:path";
import { ClaudeOwnedAgent } from "./claude-owned-agent.js";
import { CodexOwnedAgent } from "./codex-owned-agent.js";
import { GrokOwnedAgent } from "./grok-owned-agent.js";
import type { GrokConfig } from "./grok-config.js";
import type { AgentMode, OwnedAgent, OwnedAgentStartInfo } from "./owned-agent.js";
import { parseAnswer } from "./owned-commands.js";
import type { OwnedConfig, OwnedProviderConfig } from "./owned-config.js";
import {
  ExternalSessionDiscovery,
  type ExternalSessionCandidate,
  type ExternalSessionSource,
} from "./owned-discovery.js";
import { compactPrompt, providerLabel } from "./owned-format.js";
import { OwnedManageSession } from "./owned-manage-session.js";
import { OwnedPickupSession } from "./owned-pickup-session.js";
import { deferRowQuestion, primeRow } from "./owned-row-question.js";
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

/** The prime text for the wizard row; see `owned-row-question.ts` for why either
 *  row needs one at all. */
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

  get isDisposed(): boolean {
    return this.disposed;
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

  /** Absent on a session whose wizard finished before any prompt was spoken —
   *  ordinary since ADR 0005, so callers must handle the empty case. */
  get firstPrompt(): string | undefined {
    return this.record?.firstPrompt;
  }

  /** How this session reads in the phone's list. The manage row's confirm question
   *  names it with exactly this string: two sessions can share a provider and a
   *  directory, so dropping the prompt excerpt there would ask "delete which one?"
   *  about a destructive, unconfirmable action. */
  get rowTitle(): string {
    if (!this.record) return this.setupTitle();
    const prompt = this.record.firstPrompt ? compactPrompt(this.record.firstPrompt) : "";
    return `${providerLabel(this.record.agentProvider)} · ${path.basename(this.record.cwd || "/")}${prompt ? ` · ${prompt}` : ""}`;
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
    return Promise.resolve({
      id: this.id,
      title: this.rowTitle,
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
    // appendHistory() below runs before ensureAttached() and would mkdir the
    // session directory back — see save().
    if (this.disposed) throw new SessionControlError("This session was deleted.", 409);
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
      // Without this the app drops the question replayPending() is about to
      // schedule — see owned-row-question.ts.
      primeRow(this.id, SETUP_PRIME_TEXT);
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
      // Deferred, not synchronous: see owned-row-question.ts. index.ts pushes its
      // status snapshot between the prime and this, which is the order measured
      // to work.
      clearTimeout(this.questionTimer ?? undefined);
      this.questionTimer = deferRowQuestion(
        this.id,
        this.setup.pendingWire,
        this.catalog.config.setupQuestionDelayMs,
        () => this.setup !== null && !this.setup.starting,
      );
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

  /** Follows provider truth, not user intent: the bridge only reports a mode the
   *  provider confirmed, including one the agent changed on its own. */
  onMode(mode: AgentMode): void {
    if (!this.record || this.record.mode === mode) return;
    this.record.mode = mode;
    this.save(true);
  }

  onAssistant(text: string): void {
    if (this.disposed || !this.record || !text.trim()) return;
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

  /** Fire-and-forget resume for a just-adopted session: the provider child
   *  spawns while the user starts talking, so the first prompt lands on a live
   *  bridge (wizard parity). Runs the ordinary ensureAttached path — a prompt
   *  spoken meanwhile coalesces onto the in-flight attach, and failure surfaces
   *  through its could-not-resume notification. */
  warmUp(): void {
    void this.ensureAttached(false).catch(() => undefined);
  }

  private async ensureAttached(forPrompt: boolean): Promise<OwnedSessionBridge> {
    if (this.bridge) {
      this.touch();
      return this.bridge;
    }
    if (this.attachPromise) return this.attachPromise;
    const record = this.record!;
    this.attachPromise = this.catalog.attach(this, record.agentProvider, record.cwd, record.nativeSessionId, record.mode)
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

  /** Every persisting path funnels through here, including touch(). The disposed
   *  check is what keeps a deleted session deleted: `store.save()` calls
   *  `ensureSessionDirectory`, which recreates the directory `forget()` just
   *  removed — a resume or a late `activity` hook racing the delete would
   *  otherwise resurrect a half-empty row that comes back on the next restart. */
  private save(updateTimestamp: boolean): void {
    if (this.disposed || !this.record) return;
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
  private manager: OwnedManageSession | null = null;
  private pickup: OwnedPickupSession | null = null;
  private pickupProbe: Promise<void> | null = null;
  private disposed = false;
  private attachmentTail: Promise<void> = Promise.resolve();

  constructor(
    readonly config: OwnedConfig,
    private readonly factory: AgentFactory = defaultAgentFactory,
    store: OwnedSessionStore = new OwnedSessionStore(config.homeDir),
    private readonly source: ExternalSessionSource = new ExternalSessionDiscovery(config.workspaces),
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
    this.ensureManager();
    this.ensurePickup();
    const sessions = [...this.sessions.values()];
    sessions.sort((a, b) => {
      if (a.agentProvider === undefined && b.agentProvider !== undefined) return -1;
      if (a.agentProvider !== undefined && b.agentProvider === undefined) return 1;
      return b.lastUsedMs - a.lastUsedMs;
    });
    const rows = await Promise.all(sessions.map((session) => session.describe()));
    // Synthetic rows sort ahead of remembered ones; between themselves the order
    // is fixed here (wizard, manage, pickup) rather than left to Map insertion
    // surviving the sort, so the top of the list never reshuffles between polls.
    const extras: SessionDescriptor[] = [];
    if (this.manager) extras.push(await this.manager.describe());
    if (this.pickup) extras.push(await this.pickup.describe());
    if (extras.length) {
      const wizards = rows.filter((row) => row.agentProvider === undefined);
      const remembered = rows.filter((row) => row.agentProvider !== undefined);
      return [...wizards, ...extras, ...remembered];
    }
    return rows;
  }

  get(id: string): Promise<LiveSession | undefined> {
    if (this.manager && id === this.manager.id) return Promise.resolve(this.manager);
    if (this.pickup && id === this.pickup.id) return Promise.resolve(this.pickup);
    return Promise.resolve(this.sessions.get(id));
  }

  /** Cancel's way out of a synthetic row. The protocol has no navigation event —
   *  the app owns the visual — so ending the row's SSE stream is the only lever we
   *  have to put the user back on the session list, and a row whose stream we just
   *  ended must not be the one they re-enter. Dropping it here means the next
   *  `list()` mints a replacement with a **new id**, which is also what forces the
   *  app to open a fresh stream (and with it the prime + menu) instead of holding
   *  the dead one. Null first, then dispose: a `list()` racing the teardown must
   *  not describe a row whose stream has already ended. */
  retire(row: OwnedManageSession | OwnedPickupSession): void {
    if (this.manager === row) {
      // ensureManager() re-mints synchronously on the very next list().
      this.manager = null;
    } else if (this.pickup === row) {
      // ensurePickup() cannot: its probe is fire-and-forget, so the row would be
      // missing from exactly the list the app polls after Cancel — the user backs
      // out and finds nothing to re-enter. A candidate existed a moment ago, and
      // if they have since gone, opening the replacement lands on "No sessions to
      // pick up", which the row already handles.
      this.pickup = new OwnedPickupSession(`owned:${randomUUID()}`, this);
    } else return;
    row.dispose();
  }

  /** Remembered rows only, oldest first — the manage menu asks "which of these is
   *  stale", so the answer belongs at the top. Both synthetic rows are excluded by
   *  `agentProvider`, which only a promoted session has. */
  deletable(limit?: number): OwnedCatalogSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.agentProvider !== undefined && !session.isDisposed)
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
      .slice(0, Math.max(0, limit ?? Number.POSITIVE_INFINITY));
  }

  /** Forget a remembered session: stop it, release its lease, and remove its
   *  on-disk metadata and history. Native provider transcripts are untouched.
   *
   *  The order is load-bearing. `store.remove()` refuses while `lease.json`
   *  exists, and this server leases every eligible row from construction — so the
   *  dispose has to come first. The map entry is dropped before the store call,
   *  not after: by then the child is dead and the SSE stream ended, so a row left
   *  in the map would hand `get(id)` a gutted session. If the store call then
   *  throws, the record survives on disk and simply comes back on the next
   *  restart, which is the least-bad failure available here. */
  async forget(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionControlError("Session not found.", 404);
    if (!session.agentProvider) {
      throw new SessionControlError("That row is not a remembered session; nothing is stored for it.", 409);
    }
    await session.dispose();
    this.sessions.delete(id);
    try {
      this.store.remove(id);
    } catch (error) {
      if (error instanceof OwnedSessionStoreError) throw new SessionControlError(error.message, 409);
      throw error;
    }
  }

  /** External CLI sessions the user could pick up right now, newest first.
   *  Discovery failures yield [] — the row goes quiet; list() never fails. */
  async adoptable(fresh = false): Promise<ExternalSessionCandidate[]> {
    if (this.disposed) return [];
    // A provider whose binary is missing cannot attach, and adopting a session
    // that can never resume is a trap — its candidates are not offered.
    const providers = (["claude", "codex"] as const).filter(
      (provider) => this.config.providers[provider] !== undefined,
    );
    if (!providers.length) return [];
    let found: ExternalSessionCandidate[];
    try {
      found = await this.source.candidates(providers, fresh);
    } catch {
      return [];
    }
    // Dedupe against the store on disk, not the in-memory map: a remembered
    // record whose cwd fell outside the roots is skipped by the constructor but
    // still stored, and adopting it again would put two owned rows on one native
    // session. This also excludes every session even-better itself created,
    // since owned children share the user's real ~/.claude and ~/.codex.
    const known = new Set(this.store.list().map((record) => record.nativeSessionId));
    return found.filter((candidate) => !known.has(candidate.nativeSessionId));
  }

  /** Takeover-by-resume: synthesize a remembered record whose nativeSessionId is
   *  the external session's id and resume it through the ordinary attach path
   *  (Claude `resume:`, Codex `thread/resume`). With `takeOver` — the pickup row
   *  itself — the record takes that row's public id, the same promote-in-place
   *  `launch()` performs for the wizard: the phone's open stream carries straight
   *  into the adopted session, and a fire-and-forget warm-up starts the resume
   *  while the user speaks. The confirm POST never waits on the spawn. */
  async adopt(
    candidate: ExternalSessionCandidate,
    takeOver?: OwnedPickupSession,
  ): Promise<{ id: string; title: string }> {
    if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
    if (!this.config.providers[candidate.agentProvider]) {
      throw new SessionControlError(
        `${providerLabel(candidate.agentProvider)} is unavailable. Install it or set its *_BIN path, then restart even-better.`,
        503,
      );
    }
    // Re-checked against the store, not only in adoptable(): a menu can sit open
    // for minutes, and a stale menu re-emitted after a reconnect races the first
    // answer's adopt.
    if (this.store.list().some((record) => record.nativeSessionId === candidate.nativeSessionId)) {
      throw new SessionControlError("That session was already picked up.", 409);
    }
    let cwd: string;
    try {
      // resolve() with no displayed list canonicalizes the absolute path and
      // enforces WORKSPACE_ROOTS — the CLI-recorded cwd is as untrusted as a
      // phone-supplied one.
      cwd = this.config.workspaces.resolve(candidate.cwd, []);
    } catch (error) {
      const message = error instanceof WorkspaceConfigError ? error.message : String(error);
      throw new SessionControlError(message, 409);
    }
    const inspection = await this.source.inspect(candidate);
    if (!inspection) {
      throw new SessionControlError("That session's transcript is gone; it may have been deleted.", 409);
    }
    // Re-checked after the await: a dispose() landing during inspect must not
    // save a record and mint a live session after shutdown — the same
    // promote-after-dispose hazard attachNow re-checks.
    if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
    // From store.save through the handoff below nothing awaits, so no request
    // can observe a half-swapped catalog.
    const handingOff = takeOver !== undefined && this.pickup === takeOver;
    const now = new Date().toISOString();
    const record: RememberedSessionMetadata = {
      version: 1,
      id: handingOff ? takeOver.id : `owned:${randomUUID()}`,
      agentProvider: candidate.agentProvider,
      cwd,
      nativeSessionId: candidate.nativeSessionId,
      model: inspection.model || "Unknown",
      createdAt: now,
      updatedAt: now,
      // Now, not the transcript's mtime: the fresh pickup belongs at the top of
      // the phone's list.
      lastUsedAt: now,
      ...(inspection.firstPrompt ? { firstPrompt: compactPrompt(inspection.firstPrompt, 200) } : {}),
    };
    // Saved before the map entry so a crash between the two restores the row on
    // the next boot instead of losing the adoption.
    try {
      this.store.save(record);
    } catch (error) {
      if (error instanceof OwnedSessionStoreError) throw new SessionControlError(error.message, 409);
      throw error;
    }
    const session = new OwnedCatalogSession(record.id, this, record);
    this.sessions.set(record.id, session);
    try {
      session.installLease(this.store.acquireLease(record.id));
    } catch {
      // The id was minted this boot (by ensurePickup or just above) and the
      // pickup row never leases, so EEXIST is impossible; a filesystem failure
      // surfaces when the row is opened, same as the restore loop.
    }
    this.config.workspaces.touch(cwd, Date.parse(now));
    if (handingOff) {
      // The map entry is already in place, so get(record.id) resolves to the
      // adopted session the moment the pickup reference drops. handOff() only
      // clears the row's question timer — dispose() would dropSession() and end
      // the stream the phone is watching. Emissions happen here, not in the
      // pickup row, mirroring where launch() emits its promote frames.
      this.pickup = null;
      takeOver.handOff();
      emit(record.id, {
        type: "status",
        state: "idle",
        sessionId: record.id,
        provider: "codex",
        agentProvider: record.agentProvider,
      });
      emit(record.id, {
        type: "notification",
        title: "Session picked up",
        message: `Say your prompt to continue where the terminal left off. ${providerLabel(record.agentProvider)} is resuming in ${path.basename(cwd || "/")}.`,
      });
      session.warmUp();
    }
    return { id: record.id, title: session.rowTitle };
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
    mode?: AgentMode,
  ): Promise<{ bridge: OwnedSessionBridge; nativeSessionId: string; model: string }> {
    const run = this.attachmentTail.then(() => this.attachNow(session, provider, cwd, nativeSessionId, mode));
    this.attachmentTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.manager?.dispose();
    this.manager = null;
    this.pickup?.dispose();
    this.pickup = null;
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

  /** The manage row appears once there is anything to manage, so a fresh install
   *  shows only the launcher, and it is re-minted here after `retire()` takes the
   *  cancelled one away. A manager with nothing left to delete still says so
   *  rather than vanishing under the user: that `res.end()` is only ever an exit
   *  the user asked for, never a surprise mid-use. */
  private ensureManager(): void {
    if (this.disposed || this.manager) return;
    if (!this.deletable(1).length) return;
    this.manager = new OwnedManageSession(`owned:${randomUUID()}`, this);
  }

  /** The pickup row appears once at least one adoptable external session exists.
   *  The probe is fire-and-forget so list() never waits on a filesystem scan —
   *  the row simply appears on a later poll once discovery lands, which is also
   *  how a cancelled one comes back after `retire()`. With nothing left to adopt
   *  it says so instead of vanishing under the user. */
  private ensurePickup(): void {
    if (this.disposed || this.pickup || this.pickupProbe) return;
    this.pickupProbe = this.adoptable()
      .then((candidates) => {
        if (!this.disposed && !this.pickup && candidates.length) {
          this.pickup = new OwnedPickupSession(`owned:${randomUUID()}`, this);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.pickupProbe = null;
      });
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
    mode?: AgentMode,
  ): Promise<{ bridge: OwnedSessionBridge; nativeSessionId: string; model: string }> {
    if (this.disposed) throw new SessionControlError("Owned session catalog is shutting down.", 503);
    // acquireLease() below recreates the session directory, so a delete that
    // landed while this attach was queued must not be undone by it.
    if (session.isDisposed) throw new SessionControlError("This session was deleted.", 409);
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
        mode: (next) => session.onMode(next),
        unavailable: () => {
          if (bridge) session.onUnavailable(bridge);
        },
      });
      session.installStarting(bridge);
      let info: OwnedAgentStartInfo;
      try {
        info = await bridge.start(nativeSessionId, mode);
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
