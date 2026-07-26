import { randomUUID } from "node:crypto";
import path from "node:path";
import { ClaudeOwnedAgent } from "./claude-owned-agent.js";
import { CodexOwnedAgent } from "./codex-owned-agent.js";
import { GrokOwnedAgent } from "./grok-owned-agent.js";
import type { GrokConfig } from "./grok-config.js";
import type { OwnedAgent } from "./owned-agent.js";
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

function parseAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = Object.values(parsed as Record<string, unknown>)[0];
      if (typeof value === "string") return value;
    }
  } catch {
    // The phone commonly sends a plain option label.
  }
  return answer;
}

function compactPrompt(prompt: string, limit = 56): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const points = [...normalized];
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : normalized;
}

interface SetupState {
  selectedProvider: ProviderId | null;
  displayedDirectories: string[];
  pendingWire: object;
  firstPrompt: string | null;
  starting: boolean;
}

class OwnedCatalogSession implements LiveSession {
  readonly provider = "codex" as const;
  private bridge: OwnedSessionBridge | null = null;
  private releaseLease: (() => void) | null = null;
  private attachPromise: Promise<OwnedSessionBridge> | null = null;
  private setup: SetupState | null;
  private disposed = false;
  private readonly createdAt = new Date().toISOString();

  constructor(
    readonly id: string,
    private readonly catalog: OwnedSessionCatalog,
    private record: RememberedSessionMetadata | null = null,
  ) {
    this.setup = record ? null : {
      selectedProvider: null,
      displayedDirectories: [],
      pendingWire: {},
      firstPrompt: null,
      starting: false,
    };
    if (this.setup) this.askProvider(false);
  }

  get agentProvider(): ProviderId | undefined {
    return this.record?.agentProvider;
  }

  get cwd(): string {
    return this.record?.cwd ?? "";
  }

  get state(): SessionState {
    return this.setup ? "awaiting" : this.bridge?.state ?? "idle";
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
        title: "Setting up agent session…",
        timestamp: this.createdAt,
        cwd: "",
        provider: "codex",
        status: "awaiting",
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
    if (!this.setup.selectedProvider) {
      const selected = (Object.keys(this.catalog.config.providers) as ProviderId[]).find(
        (provider) => providerLabel(provider).toLowerCase() === value.toLowerCase(),
      );
      if (!selected) {
        this.notify("Choose an agent", "Select one of the available agents shown below.");
        this.askProvider(true);
        return;
      }
      emit(this.id, { type: "question_answer", answers: { answer: providerLabel(selected) } });
      this.setup.selectedProvider = selected;
      this.askDirectory(true);
      return;
    }

    let cwd: string;
    try {
      cwd = this.catalog.config.workspaces.resolve(value, this.setup.displayedDirectories);
    } catch (error) {
      const message = error instanceof WorkspaceConfigError ? error.message : "Choose an eligible working directory.";
      this.notify("Invalid directory", message);
      this.askDirectory(true);
      return;
    }
    emit(this.id, { type: "question_answer", answers: { answer: cwd } });
    await this.launch(this.setup.selectedProvider, cwd);
  }

  async interrupt(): Promise<void> {
    await this.bridge?.interrupt();
  }

  async onConnect(): Promise<void> {
    if (this.setup) {
      if (this.setup.selectedProvider) this.askDirectory(false);
      else this.askProvider(false);
      return;
    }
    try {
      await this.ensureAttached(false);
    } catch {
      // ensureAttached already emits the actionable notification for SSE entry.
    }
  }

  history(): Promise<SessionHistoryEntry[]> {
    if (!this.record) return Promise.resolve([]);
    return Promise.resolve(this.catalog.store.history(this.id).map(({ role, text }) => ({ role, text })));
  }

  replayPending(): void {
    if (this.setup) emit(this.id, this.setup.pendingWire);
    else this.bridge?.replayPending();
  }

  async detach(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = null;
    if (bridge) await bridge.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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

  private askProvider(send: boolean): void {
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
    this.setup!.displayedDirectories = this.catalog.config.workspaces.choices(4);
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

  private async launch(provider: ProviderId, cwd: string): Promise<void> {
    const setup = this.setup!;
    const firstPrompt = setup.firstPrompt;
    if (firstPrompt === null) {
      throw new SessionControlError("This setup session has no retained first prompt.", 409);
    }
    setup.starting = true;
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
        firstPrompt,
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
      if (error instanceof SessionControlError && /process limit/i.test(error.message)) {
        this.notify("Agent process limit reached", error.message);
        this.askDirectory(true);
        return;
      }
      setup.selectedProvider = null;
      this.notify(`${providerLabel(provider)} could not start`, error instanceof Error ? error.message : String(error));
      this.askProvider(true);
      return;
    }

    this.catalog.store.appendHistory(this.id, { role: "user", text: firstPrompt, timestamp: now });
    await attached.bridge.prompt(firstPrompt);
  }

  private save(updateTimestamp: boolean): void {
    if (!this.record) return;
    if (updateTimestamp) this.record.updatedAt = new Date().toISOString();
    this.catalog.store.save(this.record);
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

  private createSetup(): OwnedCatalogSession {
    // At most one setup is ever in flight: the stock app renders a single
    // ＋ New Session row, and the wizard state lives on the session its first
    // prompt created. A fresh null-session prompt means the user restarted the
    // flow, so the previous unfinished setup is dead. Without this, every such
    // prompt would leak a permanent map entry — and setups sort first in
    // list(), so the phone's list fills with "Setting up agent session…" rows.
    // Sessions that are mid-launch (starting) or already promoted are kept.
    for (const [id, existing] of [...this.sessions]) {
      if (!existing.isPendingSetup) continue;
      this.sessions.delete(id);
      void existing.dispose().catch(() => undefined);
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
          throw new SessionControlError(
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
      const info = await bridge.start(nativeSessionId);
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
