import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo } from "../src/owned-agent.js";
import type { OwnedConfig, OwnedProviderConfig } from "../src/owned-config.js";
import type {
  ExternalSessionCandidate,
  ExternalSessionInspection,
  ExternalSessionSource,
  PickupProvider,
} from "../src/owned-discovery.js";
import { OwnedSessionCatalog } from "../src/owned-session-catalog.js";
import { OwnedSessionStore, type RememberedSessionMetadata } from "../src/owned-session-store.js";
import { OwnedWorkspaceCatalog } from "../src/owned-workspaces.js";
import type { LiveSession, ProviderId, SessionDescriptor } from "../src/session.js";
import { getMessages } from "../src/sse.js";

const scratch = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-catalog-"));
const project = path.join(scratch, "project");
await mkdir(project);
after(() => rm(scratch, { recursive: true, force: true }));

const providerConfig: OwnedProviderConfig = {
  bin: "/fake/bin",
  env: {},
  startupTimeoutMs: 100,
  cancelTimeoutMs: 100,
  shutdownTimeoutMs: 100,
};

function config(homeDir: string, maxSessions = 6, directoryLimit = 0): OwnedConfig {
  return {
    homeDir,
    maxSessions,
    directoryLimit,
    manageSessionLimit: 4,
    pickupSessionLimit: 4,
    // The real delay exists only to survive the app's renderer; settle() covers the
    // one tick setTimeout(0) still costs.
    setupQuestionDelayMs: 0,
    workspaces: new OwnedWorkspaceCatalog([scratch]),
    providers: { claude: providerConfig, codex: providerConfig, grok: providerConfig },
  };
}

class FakeAgent implements OwnedAgent {
  sink: OwnedAgentSink | null = null;
  prompts: string[] = [];
  resumes: Array<string | undefined> = [];
  interrupted = 0;
  disposed = 0;

  constructor(
    readonly provider: ProviderId,
    readonly cwd: string,
    private readonly sequence: number,
    private readonly failResume = false,
    private readonly failStart = false,
  ) {}

  start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo> {
    if (this.failStart && !nativeSessionId) return Promise.reject(new Error(`${this.provider} start failed`));
    if (this.failResume && nativeSessionId) return Promise.reject(new Error(`${this.provider} resume failed`));
    this.sink = sink;
    this.resumes.push(nativeSessionId);
    const model = `fake-${this.provider}`;
    sink.event({ type: "model", model });
    return Promise.resolve({ nativeSessionId: nativeSessionId ?? `native-${this.provider}-${this.sequence}`, model });
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (text === "hang") return Promise.resolve();
    if (text === "await") {
      this.sink?.event({
        type: "question",
        id: "fake-question",
        index: 0,
        total: 1,
        question: { question: "Continue?", header: "Fake", options: [{ label: "Yes", description: "Continue" }] },
      });
      return Promise.resolve();
    }
    this.sink?.event({ type: "result", success: true, text: `reply to ${text}`, usage: { inputTokens: 1, outputTokens: 2, turns: 1 } });
    return Promise.resolve();
  }

  respondPermission(): Promise<void> {
    return Promise.resolve();
  }

  respondQuestion(answer: string): Promise<void> {
    this.sink?.event({ type: "result", success: true, text: `answered ${answer}` });
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.interrupted++;
    this.sink?.event({ type: "result", success: false, text: "Interrupted.", cancelled: true });
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

function factory(agents: FakeAgent[], failResume = false) {
  return (provider: ProviderId, cwd: string): OwnedAgent => {
    const agent = new FakeAgent(provider, cwd, agents.length, failResume);
    agents.push(agent);
    return agent;
  };
}

async function beginSetup(catalog: OwnedSessionCatalog, firstPrompt: string): Promise<LiveSession> {
  const session = await catalog.default();
  assert.ok(session);
  await session.prompt(firstPrompt);
  return session;
}

async function setup(
  catalog: OwnedSessionCatalog,
  provider: ProviderId,
  firstPrompt = `start ${provider}`,
): Promise<LiveSession> {
  const session = await beginSetup(catalog, firstPrompt);
  const id = session.id;
  await session.respondQuestion(provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok");
  await session.respondQuestion(project);
  await settle(() => session.agentProvider !== undefined);
  assert.equal(session.id, id);
  return session;
}

/** Wait for the catalog to reach `ready`. The wizard dispatches its launch without
 *  awaiting it (so the phone's POST returns immediately), so a fixed sleep would race a
 *  whole provider attach — lease, factory, start — on a loaded machine. */
async function settle(ready: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (ready()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the catalog to settle");
  }
}

/** How many wizard questions of `step` this session has emitted. */
const asked = (session: LiveSession, step: string): number =>
  getMessages(session.id, 0).filter((message) =>
    (message as { toolUseId?: string }).toolUseId?.endsWith(`:${step}`),
  ).length;

const notified = (session: LiveSession, title: string): boolean =>
  getMessages(session.id, 0).some((message) => (message as { title?: string }).title === title);

/** A picker that stops asking without this leaves the glasses thinking forever.
 *  (Cancel's own `result` + idle pair is asserted in `test-owned-server.ts`:
 *  retiring the row drops its ring buffer, so only a live stream sees them.) */
const wentIdle = (session: LiveSession): boolean =>
  getMessages(session.id, 0).some((message) =>
    (message as { type?: string }).type === "status"
    && (message as { state?: string }).state === "idle");

/** A fresh stream open, as index.ts drives it. This is what re-arms a picker
 *  that Cancel left quiet — the row rebuilds its menu, it never re-asks itself. */
async function reconnect(session: LiveSession): Promise<void> {
  await session.onConnect?.();
  session.replayPending?.();
}

/** The list minus the wizard row, which the catalog now always offers so agent and
 *  directory can be chosen before any prompt exists. Setup rows carry no
 *  `agentProvider`; remembered ones always do. */
const agentRows = (items: SessionDescriptor[]): SessionDescriptor[] =>
  items.filter((item) => item.agentProvider !== undefined);

const MANAGE_TITLE = "＋ Manage sessions";

/** Setup rows only. The manage row is synthetic too, so it shares the missing
 *  `agentProvider`, but it is never a way into the wizard. */
const wizardRows = (items: SessionDescriptor[]): SessionDescriptor[] =>
  items.filter((item) => item.agentProvider === undefined && item.title !== MANAGE_TITLE);

const manageRow = (items: SessionDescriptor[]): SessionDescriptor | undefined =>
  items.find((item) => item.title === MANAGE_TITLE);

/** The manage row through the catalog, as the phone reaches it: list, then get. */
async function openManager(catalog: OwnedSessionCatalog): Promise<LiveSession> {
  const row = manageRow(await catalog.list());
  assert.ok(row, "expected a manage row");
  const session = await catalog.get(row.id);
  assert.ok(session);
  await session.onConnect?.();
  session.replayPending?.();
  await settle(() => asked(session, "pick") >= 1);
  return session;
}

/** The ordinal label the manage menu showed for `sessionId`. */
function pickLabel(manager: LiveSession, sessionId: string, catalog: OwnedSessionCatalog): string {
  const index = catalog.deletable().findIndex((session) => session.id === sessionId);
  assert.ok(index >= 0, "expected the session to be deletable");
  const wire = getMessages(manager.id, 0)
    .filter((message) => (message as { toolUseId?: string }).toolUseId?.endsWith(":pick"))
    .at(-1) as { questions?: Array<{ options: Array<{ label: string }> }> } | undefined;
  const label = wire?.questions?.[0]?.options[index]?.label;
  assert.ok(label, "expected a menu option for the session");
  return label;
}

test("an openable wizard row exists before any prompt and adopts one when it arrives", async () => {
  const home = path.join(scratch, "state-prompt-setup");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    // The whole point of the reordering: a way into the wizard that exists before the
    // user has said anything, so agent and directory come first.
    const initial = await catalog.list();
    assert.deepEqual(agentRows(initial), []);
    assert.equal(initial.length, 1);
    assert.equal(initial[0]?.title, "＋ Agent setup");

    const session = await catalog.default();
    assert.ok(session);
    // A ＋ New Session prompt takes over that same row rather than adding a second.
    assert.equal(session.id, initial[0]?.id);
    await session.prompt("first prompt");
    const publicId = session.id;

    assert.match(publicId, /^owned:/);
    assert.equal((await catalog.get(publicId))?.id, publicId);
    const carrying = await catalog.list();
    assert.equal(carrying.length, 1);
    assert.equal(carrying[0]?.title, "Setting up · first prompt");

    await session.onConnect?.();
    session.replayPending?.();
    // The prime is what makes the app render the question that follows it.
    assert.ok(getMessages(publicId, 0).some((message) =>
      (message as { type?: string; text?: string }).type === "user_prompt"
      && (message as { text?: string }).text === "New agent session",
    ));
    // Deferred by a tick even at delay 0 — the app drops a question sent in the same
    // tick as the stream opening.
    await settle(() => getMessages(publicId, 0).some((message) =>
      (message as { type?: string; toolUseId?: string }).type === "user_question"
      && (message as { toolUseId?: string }).toolUseId?.endsWith(":provider"),
    ));
    await assert.rejects(session.prompt("second prompt"), /finish choosing an agent and directory/);
  } finally {
    await catalog.dispose();
  }
});

test("a restarted setup reuses its public id instead of dropping the phone's stream", async () => {
  const home = path.join(scratch, "state-setup-eviction");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  try {
    // Every null-session prompt used to mint a permanent map entry, and setups sort
    // first in list(), so the top of the phone's list filled with dead wizard
    // rows. Disposing the previous one instead ended its SSE stream with no
    // notification, which killed the wizard the phone had open whenever a prompt
    // arrived twice. Reusing the pending setup does both jobs.
    const ids: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await beginSetup(catalog, `abandoned ${attempt}`);
      ids.push(session.id);
    }
    const listed = await catalog.list();
    assert.equal(listed.length, 1, `expected one setup row, got ${JSON.stringify(listed.map((s) => s.title))}`);
    assert.equal(listed[0]?.title, "Setting up · abandoned 4");
    // One stable public id across every restart, still resolvable — the app keeps its
    // stream and its id rather than being left on a dead one.
    assert.equal(new Set(ids).size, 1);
    assert.equal(listed[0]?.id, ids[0]);
    assert.ok(await catalog.get(ids[0]!));
    // Each restart re-asks the agent question rather than leaving a stale menu.
    assert.equal(
      getMessages(ids[0]!, 0).filter((message) =>
        (message as { toolUseId?: string }).toolUseId?.endsWith(":provider"),
      ).length,
      4,
    );

    // A completed setup is a remembered session and is never reused this way.
    const live = await setup(catalog, "codex", "keep me");
    await beginSetup(catalog, "another abandoned");
    const after = await catalog.list();
    assert.equal(wizardRows(after).length, 1);
    assert.deepEqual(agentRows(after).map((item) => item.id), [live.id]);
    // Something is remembered now, so the manage row has joined them.
    assert.ok(manageRow(after));
  } finally {
    await catalog.dispose();
  }
});

test("successful setup persists and dispatches the retained first prompt once", async () => {
  const home = path.join(scratch, "state-retained-prompt");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  try {
    const session = await catalog.default();
    assert.ok(session);
    await session.prompt("inspect this project");
    const publicId = session.id;

    await session.respondQuestion("Claude");
    await session.respondQuestion(project);
    await settle(() => session.agentProvider !== undefined);

    assert.equal(session.id, publicId);
    assert.equal(session.agentProvider, "claude");
    assert.deepEqual(agents[0]?.prompts, ["inspect this project"]);
    assert.equal(catalog.store.get(publicId)?.firstPrompt, "inspect this project");
    assert.deepEqual(await session.history?.(), [
      { role: "user", text: "inspect this project" },
      { role: "assistant", text: "reply to inspect this project" },
    ]);
    const descriptors = agentRows(await catalog.list());
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0]?.id, publicId);
    assert.equal(descriptors[0]?.title, "Claude · project · inspect this project");
    // Promotion frees the wizard slot, so the list offers a fresh way in.
    assert.equal(wizardRows(await catalog.list())[0]?.title, "＋ Agent setup");
  } finally {
    await catalog.dispose();
  }
});

test("provider startup failure reopens setup with the first prompt retained", async () => {
  const home = path.join(scratch, "state-start-retry");
  const agents: FakeAgent[] = [];
  let failNextStart = true;
  const catalog = new OwnedSessionCatalog(config(home), (provider, cwd) => {
    const agent = new FakeAgent(provider, cwd, agents.length, false, failNextStart);
    failNextStart = false;
    agents.push(agent);
    return agent;
  });
  try {
    const session = await catalog.default();
    assert.ok(session);
    await session.prompt("keep this exact prompt");

    await session.respondQuestion("Claude");
    await session.respondQuestion(project);
    await settle(() => asked(session, "retry") >= 1);
    assert.equal(session.agentProvider, undefined);
    assert.equal((await session.describe()).title, "Setting up · keep this exact prompt");
    assert.ok(notified(session, "Claude could not start"));
    // A failed start reopens as a one-tap retry that keeps both answers. Walking the
    // glasses back through the agent and directory questions is what looped the
    // wizard forever whenever a provider kept timing out.
    assert.ok(getMessages(session.id, 0).some((message) =>
      (message as { type?: string }).type === "user_question"
      && (message as { toolUseId?: string }).toolUseId?.endsWith(":retry"),
    ));

    await session.respondQuestion("Retry");
    await settle(() => session.agentProvider !== undefined);

    assert.deepEqual(agents[0]?.prompts, []);
    assert.deepEqual(agents[1]?.prompts, ["keep this exact prompt"]);
    assert.equal(catalog.store.get(session.id)?.firstPrompt, "keep this exact prompt");
    assert.deepEqual(await session.history?.(), [
      { role: "user", text: "keep this exact prompt" },
      { role: "assistant", text: "reply to keep this exact prompt" },
    ]);
  } finally {
    await catalog.dispose();
  }
});

test("the retry menu keeps both answers and never reopens the whole wizard", async () => {
  const home = path.join(scratch, "state-retry-menu");
  const agents: FakeAgent[] = [];
  // Every start fails, which is exactly the observed incident: a provider that kept
  // timing out walked the glasses through agent + directory on every attempt, four
  // full cycles in two minutes, with no way out.
  const catalog = new OwnedSessionCatalog(config(home), (provider, cwd) => {
    const agent = new FakeAgent(provider, cwd, agents.length, false, true);
    agents.push(agent);
    return agent;
  });
  try {
    const session = await catalog.default();
    assert.ok(session);
    await session.prompt("retry me");
    await session.respondQuestion("Claude");
    await session.respondQuestion(project);
    await settle(() => asked(session, "retry") >= 1);
    assert.equal(asked(session, "retry"), 1);
    assert.equal(asked(session, "provider"), 0);
    assert.equal(asked(session, "directory"), 1);

    // Retry re-runs the same agent in the same directory without re-asking either.
    await session.respondQuestion("Retry");
    await settle(() => asked(session, "retry") >= 2);
    assert.equal(agents.length, 2);
    assert.equal(agents[1]?.provider, "claude");
    assert.equal(agents[1]?.cwd, fs.realpathSync(project));
    assert.equal(asked(session, "retry"), 2);
    assert.equal(asked(session, "provider"), 0);
    assert.equal(asked(session, "directory"), 1);
    // Repeated failure is visible rather than silent.
    assert.ok(getMessages(session.id, 0).some((message) =>
      (message as { message?: string }).message?.includes("(attempt 2)"),
    ));

    // Change directory reopens only the directory question.
    await session.respondQuestion("Change directory");
    assert.equal(asked(session, "directory"), 2);
    assert.equal(asked(session, "provider"), 0);
    await session.respondQuestion(project);
    await settle(() => asked(session, "retry") >= 3);
    assert.equal(asked(session, "retry"), 3);

    // Change agent is the only route back to the agent question.
    await session.respondQuestion("Change agent");
    assert.equal(asked(session, "provider"), 1);

    // The retained first prompt survives every failure, and nothing was persisted.
    await session.respondQuestion("Codex");
    await session.respondQuestion(project);
    await settle(() => asked(session, "retry") >= 4);
    assert.equal(agents.at(-1)?.provider, "codex");
    assert.equal(session.agentProvider, undefined);
    assert.equal((await session.describe()).title, "Setting up · retry me");
    assert.equal(catalog.store.get(session.id), undefined);
  } finally {
    await catalog.dispose();
  }
});

test("restart lists remembered sessions only and lazily resumes their native context", async () => {
  const home = path.join(scratch, "state-main");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  assert.deepEqual(agentRows(await catalog.list()), []);
  const fresh = await setup(catalog, "claude", "first prompt");
  const publicId = fresh.id;
  assert.equal(fresh.id, publicId);
  assert.equal(fresh.provider, "codex");
  assert.equal(fresh.agentProvider, "claude");
  assert.deepEqual(agents[0]?.prompts, ["first prompt"]);
  assert.equal(catalog.store.get(publicId)?.nativeSessionId, "native-claude-0");
  assert.equal(catalog.store.get(publicId)?.firstPrompt, "first prompt");
  assert.deepEqual(await fresh.history?.(), [
    { role: "user", text: "first prompt" },
    { role: "assistant", text: "reply to first prompt" },
  ]);
  assert.match((await fresh.describe()).title, /^Claude · project · first prompt$/);
  await catalog.dispose();

  const resumedAgents: FakeAgent[] = [];
  const restored = new OwnedSessionCatalog(config(home), factory(resumedAgents));
  try {
    // Restart restores remembered rows only; the wizard row is catalog state, minted
    // fresh, and never persisted.
    const descriptors = agentRows(await restored.list());
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0]?.id, publicId);
    assert.match(descriptors[0]?.title ?? "", /^Claude · project · first prompt$/);
    assert.equal(wizardRows(await restored.list()).length, 1);
    const remembered = await restored.get(publicId);
    assert.ok(remembered);
    assert.deepEqual(await remembered.history?.(), [
      { role: "user", text: "first prompt" },
      { role: "assistant", text: "reply to first prompt" },
    ]);
    await remembered.onConnect?.();
    assert.deepEqual(resumedAgents[0]?.resumes, ["native-claude-0"]);
    await remembered.prompt("continued");
    await settle(() => getMessages(remembered.id, 0).some((m) => (m as { type?: string }).type === "result"));
    assert.equal((await remembered.history?.())?.at(-1)?.text, "reply to continued");
  } finally {
    await restored.dispose();
  }
});

test("MAX_OWNED_SESSIONS caps attached processes and evicts only idle LRU sessions", async () => {
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(path.join(scratch, "state-cap"), 1), factory(agents));
  try {
    const first = await setup(catalog, "claude");
    const second = await setup(catalog, "grok");
    assert.equal(agents[0]?.disposed, 1);
    assert.equal(second.agentProvider, "grok");

    await first.onConnect?.();
    assert.equal(agents[1]?.disposed, 1);
    assert.deepEqual(agents[2]?.resumes, ["native-claude-0"]);
    await first.prompt("hang");
    const third = await beginSetup(catalog, "start codex");
    await third.respondQuestion("Codex");
    await third.respondQuestion(project);
    await settle(() => asked(third, "retry") >= 1);
    assert.equal(third.agentProvider, undefined);
    assert.equal(first.state, "busy");
    assert.equal(agents[2]?.disposed, 0);
    const afterFailedSetup = await catalog.list();
    assert.equal(wizardRows(afterFailedSetup).length, 1);
    assert.equal(afterFailedSetup[0]?.id, third.id);
    assert.ok(notified(third, "Agent process limit reached"));

    await first.interrupt();
    await settle(() => first.state === "idle");
    await first.prompt("await");
    assert.equal(first.state, "awaiting");
    await third.respondQuestion("Retry");
    await settle(() => asked(third, "retry") >= 2);
    assert.equal(third.agentProvider, undefined);
    assert.equal(agents[2]?.disposed, 0);
  } finally {
    await catalog.dispose();
  }
});

// A bridge is installed only once start() resolves, so a teardown landing mid-spawn used
// to find nothing to dispose: the child (detached for codex and grok) outlived the
// server, the session promoted onto a disposed object, and metadata landed after
// shutdown. The probe for this never exited — the bridge's stats interval kept firing.
test("shutdown during a spawning provider disposes the child and does not promote", async () => {
  const home = path.join(scratch, "state-dispose-race");
  let spawning = false;
  let release = (): void => {};
  let disposed = 0;
  class SlowStart implements OwnedAgent {
    readonly provider = "claude" as const;
    constructor(readonly cwd: string) {}
    start(): Promise<OwnedAgentStartInfo> {
      spawning = true;
      return new Promise((resolve) => {
        release = () => resolve({ nativeSessionId: "native-slow", model: "fake-claude" });
      });
    }
    prompt(): Promise<void> { return Promise.resolve(); }
    respondPermission(): Promise<void> { return Promise.resolve(); }
    respondQuestion(): Promise<void> { return Promise.resolve(); }
    interrupt(): Promise<void> { return Promise.resolve(); }
    dispose(): Promise<void> { disposed += 1; return Promise.resolve(); }
  }
  const catalog = new OwnedSessionCatalog(config(home), (_provider, cwd) => new SlowStart(cwd));
  const session = await beginSetup(catalog, "work that never starts");
  await session.respondQuestion("Claude");
  await session.respondQuestion(project);
  await settle(() => spawning);
  assert.equal(disposed, 0);

  await catalog.dispose();
  assert.equal(disposed, 1, "the spawning child must be disposed by shutdown");

  release();
  await settle(() => true);
  assert.equal(disposed, 1);
  assert.equal(session.agentProvider, undefined, "a disposed session must not promote");
  assert.equal(catalog.store.get(session.id), undefined, "no metadata may be written after shutdown");
});

test("resume failures keep remembered metadata and local history", async () => {
  const home = path.join(scratch, "state-failure");
  const store = new OwnedSessionStore(home);
  const now = new Date().toISOString();
  const record: RememberedSessionMetadata = {
    version: 1,
    id: "owned:11111111-1111-4111-8111-111111111111",
    agentProvider: "codex",
    cwd: fs.realpathSync(project),
    nativeSessionId: "native-does-not-resume",
    model: "fake-codex",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    firstPrompt: "remember me",
  };
  store.save(record);
  store.appendHistory(record.id, { role: "user", text: "remember me", timestamp: now });
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents, true), store);
  try {
    const remembered = await catalog.get(record.id);
    assert.ok(remembered);
    await remembered.onConnect?.();
    assert.ok((await catalog.list()).some((session) => session.id === record.id));
    assert.deepEqual(await remembered.history?.(), [{ role: "user", text: "remember me" }]);
    assert.ok(getMessages(record.id, 0).some((message) => (message as { title?: string }).title === "Codex session could not resume"));
    assert.ok(store.get(record.id));
  } finally {
    await catalog.dispose();
  }
});

test("the manage row appears only once something is remembered, and sorts after the wizard", async () => {
  const home = path.join(scratch, "state-manage-visibility");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    // A fresh install has nothing to manage, so the row would only be a dead end.
    const empty = await catalog.list();
    assert.equal(manageRow(empty), undefined);
    assert.equal(empty.length, 1);

    await setup(catalog, "claude");
    const listed = await catalog.list();
    assert.ok(manageRow(listed));
    // Wizard first, manager second, remembered rows after: fixed here rather than
    // left to Map order surviving the sort, so the top of the list is stable.
    assert.equal(listed[0]?.title, "＋ Agent setup");
    assert.equal(listed[1]?.title, MANAGE_TITLE);
    assert.equal(listed[2]?.agentProvider, "claude");
    // Idle until it is opened: `awaiting` is derived from a menu that exists, and
    // a utility row nobody has opened is not waiting on the user.
    assert.equal(manageRow(listed)?.status, "idle");
  } finally {
    await catalog.dispose();
  }
});

test("the manage row deletes a remembered session and re-arms its menu", async () => {
  const home = path.join(scratch, "state-manage-delete");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  const store = new OwnedSessionStore(home);
  try {
    const doomed = await setup(catalog, "claude", "delete me");
    const kept = await setup(catalog, "grok", "keep me");
    const directory = path.join(home, "sessions", doomed.id.replace("owned:", ""));
    assert.ok(fs.existsSync(directory));

    const manager = await openManager(catalog);
    // The label carries the prompt excerpt, like the pickup row's: agent and
    // folder alone do not say which session is about to be deleted.
    assert.equal(pickLabel(manager, doomed.id, catalog), "1 · Claude · project · delete me");
    await manager.respondQuestion(pickLabel(manager, doomed.id, catalog));
    assert.equal(asked(manager, "confirm"), 1);

    await manager.respondQuestion("Delete forever");
    await settle(() => store.list().length === 1);

    assert.equal(store.get(doomed.id), undefined);
    assert.equal(fs.existsSync(directory), false, "the session directory should be gone");
    assert.equal(await catalog.get(doomed.id), undefined);
    assert.deepEqual(agentRows(await catalog.list()).map((row) => row.id), [kept.id]);
    // Its child is stopped, not just forgotten.
    assert.equal(agents[0]?.disposed, 1);
    assert.ok(notified(manager, "Session deleted"));
    // The row stays usable for a second delete.
    await settle(() => asked(manager, "pick") >= 2);

    // Nothing recreates the directory afterwards: save()/appendHistory() would
    // mkdir it back, and a late activity hook is exactly how that happened.
    await settle();
    assert.equal(fs.existsSync(directory), false);
    assert.equal(store.get(doomed.id), undefined);
  } finally {
    await catalog.dispose();
  }
});

test("the manage row keeps a session on Keep, on Cancel, and on an unrecognized answer", async () => {
  const home = path.join(scratch, "state-manage-keep");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  const store = new OwnedSessionStore(home);
  try {
    const session = await setup(catalog, "codex", "keep me");
    const manager = await openManager(catalog);

    await manager.respondQuestion(pickLabel(manager, session.id, catalog));
    await manager.respondQuestion("Keep");
    assert.equal(store.list().length, 1);
    assert.equal(asked(manager, "pick"), 2);

    // The literal index.ts substitutes for an empty answer body must never delete.
    await manager.respondQuestion(pickLabel(manager, session.id, catalog));
    await manager.respondQuestion("skip");
    assert.equal(store.list().length, 1);
    assert.ok(notified(manager, "Choose an option"));
    assert.equal(asked(manager, "confirm"), 3);

    await manager.respondQuestion("Keep");
    assert.equal(asked(manager, "pick"), 3);

    // Cancel leaves the row: it closes the turn the prime opened, ends the row's
    // stream and retires the row, instead of putting the same picker back — which
    // was a menu with no way out of it.
    await manager.respondQuestion("Cancel");
    assert.equal(store.list().length, 1);
    assert.equal(manager.state, "idle");
    assert.equal(await catalog.get(manager.id), undefined, "the cancelled row is gone");
    // dropSession() took the row's SSE buffer with it, which is the same call
    // that ends the phone's stream. (That the picker is not re-asked first is
    // asserted on a live stream in test-owned-server.ts.)
    assert.equal(getMessages(manager.id, 0).length, 0, "the row's stream was dropped");
    // The menu is gone, so a stray second tap cannot land in the unrecognized
    // branch and re-arm it.
    await assert.rejects(manager.respondQuestion("Cancel"), /No question is pending/);

    // A replacement with a new id is what brings the picker back: the app has to
    // open a fresh stream for it, and that is what primes and asks.
    const replacement = await openManager(catalog);
    assert.notEqual(replacement.id, manager.id);
    assert.equal(replacement.state, "awaiting");
    await replacement.respondQuestion("Cancel");
    assert.equal(store.list().length, 1);
    assert.equal(await catalog.get(replacement.id), undefined);
  } finally {
    await catalog.dispose();
  }
});

test("the manage row deletes a busy session and stops its child", async () => {
  const home = path.join(scratch, "state-manage-busy");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  const store = new OwnedSessionStore(home);
  try {
    const session = await setup(catalog, "grok", "busy one");
    await session.prompt("hang");
    assert.equal(session.state, "busy");

    const manager = await openManager(catalog);
    await manager.respondQuestion(pickLabel(manager, session.id, catalog));
    await manager.respondQuestion("Delete forever");
    await settle(() => store.list().length === 0);

    // Unlike LRU eviction, which never takes a busy row, this interrupts and tears
    // the child down rather than refusing.
    assert.equal(agents[0]?.disposed, 1);
    assert.equal(await catalog.get(session.id), undefined);
  } finally {
    await catalog.dispose();
  }
});

test("the last delete leaves the row in place, saying there is nothing left", async () => {
  const home = path.join(scratch, "state-manage-empty");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  const store = new OwnedSessionStore(home);
  try {
    const session = await setup(catalog, "claude", "only one");
    const manager = await openManager(catalog);
    await manager.respondQuestion(pickLabel(manager, session.id, catalog));
    await manager.respondQuestion("Delete forever");
    await settle(() => store.list().length === 0);
    await settle(() => notified(manager, "No sessions to delete"));

    // Disposing it would res.end() the phone's stream with no notification, so the
    // row survives with an explanation instead of vanishing mid-use.
    assert.ok(manageRow(await catalog.list()));
    assert.equal(asked(manager, "pick"), 1, "an empty menu must not be re-emitted");
    // …and it says so idle. A row with no menu left that still reads `awaiting`
    // is a thinking indicator nothing will ever clear.
    assert.ok(wentIdle(manager));
    assert.equal(manager.state, "idle");
    assert.equal(manageRow(await catalog.list())?.status, "idle");
  } finally {
    await catalog.dispose();
  }
});

test("the manage row refuses prompts and is not itself deletable", async () => {
  const home = path.join(scratch, "state-manage-guards");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    await setup(catalog, "claude", "something");
    const manager = await openManager(catalog);
    await assert.rejects(manager.prompt("do a thing"), /only removes sessions/);
    // A ＋ New Session prompt must still land on the wizard, not here.
    const created = await catalog.default();
    assert.notEqual(created?.id, manager.id);

    await assert.rejects(catalog.forget(manager.id), /Session not found/);
    const wizard = wizardRows(await catalog.list())[0];
    assert.ok(wizard);
    await assert.rejects(catalog.forget(wizard.id), /not a remembered session/);
  } finally {
    await catalog.dispose();
  }
});

test("the confirm question names the exact row when two sessions share a directory", async () => {
  const home = path.join(scratch, "state-manage-ambiguous");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    // Same provider, same cwd: only the excerpt tells them apart, so the confirm
    // has to carry the full row title or it asks "delete which one?" about
    // something irreversible.
    await setup(catalog, "claude", "first task");
    await setup(catalog, "claude", "second task");
    const manager = await openManager(catalog);
    const oldest = catalog.deletable()[0];
    assert.ok(oldest);

    await manager.respondQuestion(pickLabel(manager, oldest.id, catalog));
    const confirm = getMessages(manager.id, 0)
      .filter((message) => (message as { toolUseId?: string }).toolUseId?.endsWith(":confirm"))
      .at(-1) as { questions?: Array<{ question: string }> } | undefined;
    assert.match(confirm?.questions?.[0]?.question ?? "", /first task/);
  } finally {
    await catalog.dispose();
  }
});

test("the delete menu pages instead of growing past what the glasses render", async () => {
  const home = path.join(scratch, "state-manage-paging");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    // Eleven options did not render on a physical phone, so the menu is capped and
    // pages; recent sessions must stay reachable under that cap.
    for (let index = 0; index < 6; index++) await setup(catalog, "claude", `task ${index}`);
    const manager = await openManager(catalog);

    const options = (): Array<{ label: string }> => {
      const wire = getMessages(manager.id, 0)
        .filter((message) => (message as { toolUseId?: string }).toolUseId?.endsWith(":pick"))
        .at(-1) as { questions?: Array<{ options: Array<{ label: string }> }> } | undefined;
      return wire?.questions?.[0]?.options ?? [];
    };

    // Four sessions + More + Cancel.
    assert.equal(options().length, 6);
    assert.equal(options().at(-1)?.label, "Cancel");
    assert.equal(options().at(-2)?.label, "More sessions…");
    assert.ok(options()[0]?.label.startsWith("1 · "));

    await manager.respondQuestion("More sessions…");
    // The tail page: two sessions, no More, ordinals continue rather than restart.
    assert.equal(options().length, 3);
    assert.equal(options()[0]?.label.startsWith("5 · "), true);
    assert.equal(options().at(-1)?.label, "Cancel");

    // The newest session is reachable on that page, which is the point of paging.
    const newest = catalog.deletable().at(-1);
    assert.ok(newest);
    await manager.respondQuestion(options()[1]!.label);
    await manager.respondQuestion("Delete forever");
    await settle(() => catalog.deletable().length === 5);
    assert.equal(await catalog.get(newest.id), undefined);
    // After a delete the list shifted, so paging restarts at the oldest.
    assert.ok(options()[0]?.label.startsWith("1 · "));
  } finally {
    await catalog.dispose();
  }
});

// ---------------------------------------------------------------------------
// ＋ Pick up session: adopting external CLI sessions (takeover-by-resume).

const PICKUP_TITLE = "＋ Pick up session";

class FakeSource implements ExternalSessionSource {
  candidateCalls = 0;
  constructor(
    public available: ExternalSessionCandidate[],
    public inspection: () => Promise<ExternalSessionInspection | null> =
      () => Promise.resolve({ model: "fake-model", firstPrompt: "refactor the parser" }),
  ) {}

  /** Deferred by a macrotask, not resolved inline: real discovery is filesystem
   *  I/O and the SDK's session listing, so a promise that settles within the same
   *  microtask turn hides every latency the fire-and-forget probe actually has —
   *  including a replacement pickup row arriving one poll late. */
  candidates(providers: readonly PickupProvider[]): Promise<ExternalSessionCandidate[]> {
    this.candidateCalls++;
    const matching = this.available.filter((candidate) => providers.includes(candidate.agentProvider));
    return new Promise((resolve) => setTimeout(() => resolve(matching), 0));
  }

  inspect(): Promise<ExternalSessionInspection | null> {
    return this.inspection();
  }
}

function externalClaude(id: string, cwd: string, lastModifiedMs = Date.now()): ExternalSessionCandidate {
  return { agentProvider: "claude", nativeSessionId: id, cwd, title: "refactor the parser", lastModifiedMs };
}

/** The pickup row appears on a poll after the fire-and-forget probe lands. */
async function waitForPickupRow(catalog: OwnedSessionCatalog): Promise<SessionDescriptor> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const row = (await catalog.list()).find((item) => item.title === PICKUP_TITLE);
    if (row) return row;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the pickup row");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openPickup(catalog: OwnedSessionCatalog): Promise<LiveSession> {
  const row = await waitForPickupRow(catalog);
  const session = await catalog.get(row.id);
  assert.ok(session);
  await session.onConnect?.();
  session.replayPending?.();
  await settle(() => asked(session, "pick") >= 1);
  return session;
}

test("adopting promotes the pickup row in place and warms up the resume", async () => {
  const home = path.join(scratch, "state-pickup-adopt");
  const agents: FakeAgent[] = [];
  const source = new FakeSource([externalClaude("external-claude-1", project)]);
  const store = new OwnedSessionStore(home);
  const catalog = new OwnedSessionCatalog(config(home), factory(agents), store, source);
  try {
    const pickup = await openPickup(catalog);

    await pickup.respondQuestion("1 · Claude · project · refactor the parser");
    await settle(() => asked(pickup, "confirm") >= 1);
    await pickup.respondQuestion("Pick up here");
    await settle(() => notified(pickup, "Session picked up"));

    // Promote-in-place: the record lives under the row's own public id, and the
    // open stream got the same idle frame launch() emits for the wizard.
    const records = store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, pickup.id);
    assert.equal(records[0]?.nativeSessionId, "external-claude-1");
    assert.equal(records[0]?.agentProvider, "claude");
    assert.equal(records[0]?.cwd, project);
    assert.equal(records[0]?.firstPrompt, "refactor the parser");
    assert.ok(getMessages(pickup.id, 0).some((message) =>
      (message as { type?: string; state?: string }).type === "status"
      && (message as { state?: string }).state === "idle",
    ));

    // The warm-up resumes the external session before any prompt, and its
    // attach late-binds the model over the inspect-time value.
    await settle(() => agents.length === 1);
    assert.deepEqual(agents[0]?.resumes, ["external-claude-1"]);
    await settle(() => store.list().find((record) => record.id === pickup.id)?.model === "fake-claude");

    // get() routes past the handed-off row; prompting rides the warmed bridge
    // instead of spawning a second child.
    const adopted = await catalog.get(pickup.id);
    assert.ok(adopted);
    assert.notEqual(adopted, pickup);
    assert.equal(adopted.agentProvider, "claude");
    await adopted.prompt("hello");
    assert.equal(agents.length, 1);
    assert.ok(agents[0]?.prompts.includes("hello"));

    // The sole candidate was adopted, so no fresh pickup row appears and the
    // picker was never re-asked on the adopted stream.
    for (let poll = 0; poll < 3; poll++) {
      assert.equal((await catalog.list()).find((row) => row.title === PICKUP_TITLE), undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      (await catalog.list()).map((row) => row.title),
      ["＋ Agent setup", MANAGE_TITLE, "Claude · project · refactor the parser"],
    );
    assert.equal(asked(pickup, "pick"), 1);

    // Forgetting the adopted row releases the native session for adoption again.
    await catalog.forget(pickup.id);
    assert.equal(agents[0]?.disposed, 1);
    assert.deepEqual(store.list(), []);
    assert.equal((await catalog.adoptable(true)).length, 1);
  } finally {
    await catalog.dispose();
  }
});

test("cancel, keep, and unrecognized answers never adopt; failures notify without persisting", async () => {
  const home = path.join(scratch, "state-pickup-refusals");
  const source = new FakeSource([externalClaude("external-claude-2", project)]);
  const store = new OwnedSessionStore(home);
  const catalog = new OwnedSessionCatalog(config(home), factory([]), store, source);
  try {
    const pickup = await openPickup(catalog);

    // The literal "skip" index.ts substitutes for an empty body keeps the session.
    await pickup.respondQuestion("1 · Claude · project · refactor the parser");
    await settle(() => asked(pickup, "confirm") >= 1);
    await pickup.respondQuestion("skip");
    await settle(() => asked(pickup, "confirm") >= 2);
    await pickup.respondQuestion("Keep in terminal");
    await settle(() => asked(pickup, "pick") >= 2);

    // Cancel leaves the row here too: the turn closes, the row is retired, and a
    // replacement with a new id carries the picker.
    await pickup.respondQuestion("Cancel");
    // dropSession() took the row's SSE buffer with it, which is the same call
    // that ends the phone's stream. (That the picker is not re-asked first is
    // asserted on a live stream in test-owned-server.ts.)
    assert.equal(getMessages(pickup.id, 0).length, 0, "the row's stream was dropped");
    assert.equal(pickup.state, "idle");
    assert.equal(await catalog.get(pickup.id), undefined, "the cancelled row is gone");
    await assert.rejects(pickup.respondQuestion("Cancel"), /No question is pending/);
    assert.deepEqual(store.list(), []);

    // The replacement is on the very first poll after Cancel, not a later one:
    // the app lists once as it backs out of the row, and a row left to the
    // fire-and-forget discovery probe would not be on that list. (The polling
    // `openPickup` helper hides exactly this.)
    const replacement = (await catalog.list()).find((item) => item.title === PICKUP_TITLE);
    assert.ok(replacement, "expected a replacement pickup row on the first poll");
    assert.notEqual(replacement.id, pickup.id);
    const second = await catalog.get(replacement.id);
    assert.ok(second);
    await reconnect(second);
    await settle(() => asked(second, "pick") >= 1);

    // A candidate whose transcript vanished between pick and adopt.
    source.inspection = () => Promise.resolve(null);
    await second.respondQuestion("1 · Claude · project · refactor the parser");
    await second.respondQuestion("Pick up here");
    await settle(() => notified(second, "Could not pick up session"));
    assert.deepEqual(store.list(), []);

    // A cwd outside WORKSPACE_ROOTS is refused with the actionable message. The
    // menu on screen predates the swap, so a fresh stream open rebuilds it and
    // shows the outside candidate before it is picked.
    const outside = await mkdtemp(path.join(os.tmpdir(), "even-better-pickup-outside-"));
    try {
      source.available = [externalClaude("external-claude-3", outside)];
      source.inspection = () => Promise.resolve({ model: "fake-model" });
      await reconnect(second);
      await settle(() => asked(second, "pick") >= 3);
      await second.respondQuestion(`1 · Claude · ${path.basename(outside)} · refactor the parser`);
      await second.respondQuestion("Pick up here");
      await settle(() => getMessages(second.id, 0).some((message) =>
        (message as { message?: string }).message?.includes("WORKSPACE_ROOTS") === true,
      ));
      assert.deepEqual(store.list(), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    // A live row whose candidates vanished beneath it lands on the empty state
    // (success no longer reaches it — the row hands itself off instead).
    source.available = [];
    await reconnect(second);
    await settle(() => notified(second, "No sessions to pick up"));
    assert.equal(second.state, "idle");
  } finally {
    await catalog.dispose();
  }
});

test("answers are rejected while an adopt is in flight, and the pick menu pages", async () => {
  const home = path.join(scratch, "state-pickup-paging");
  const many = Array.from({ length: 6 }, (_, index) =>
    externalClaude(`external-claude-page-${index}`, project, Date.now() - index * 1_000));
  let releaseInspect: (value: ExternalSessionInspection | null) => void = () => undefined;
  const source = new FakeSource(many, () => new Promise((resolve) => { releaseInspect = resolve; }));
  const store = new OwnedSessionStore(home);
  const catalog = new OwnedSessionCatalog(config(home), factory([]), store, source);
  try {
    const pickup = await openPickup(catalog);
    const options = (): Array<{ label: string }> => {
      const wire = getMessages(pickup.id, 0)
        .filter((message) => (message as { toolUseId?: string }).toolUseId?.endsWith(":pick"))
        .at(-1) as { questions?: Array<{ options: Array<{ label: string }> }> } | undefined;
      return wire?.questions?.[0]?.options ?? [];
    };

    // Four candidates + More + Cancel, newest first.
    assert.equal(options().length, 6);
    assert.equal(options().at(-2)?.label, "More sessions…");
    assert.ok(options()[0]?.label.startsWith("1 · "));
    await pickup.respondQuestion("More sessions…");
    await settle(() => asked(pickup, "pick") >= 2);
    // The tail page: ordinals continue rather than restart.
    assert.equal(options().length, 3);
    assert.ok(options()[0]?.label.startsWith("5 · "));

    await pickup.respondQuestion(options()[0]!.label);
    await settle(() => asked(pickup, "confirm") >= 1);
    // The confirm answer resolves only once the adopt finishes (the deferred
    // inspect holds it open), which is exactly the window a second answer races.
    const inflight = pickup.respondQuestion("Pick up here");
    await assert.rejects(pickup.respondQuestion("anything"), /being picked up/);
    releaseInspect({ model: "fake-model" });
    await inflight;
    await settle(() => notified(pickup, "Session picked up"));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.id, pickup.id);

    // Candidates remain, so a fresh pickup row with a new id appears; the old
    // id routes to the adopted session, and a stale answer to it cannot adopt.
    const fresh = await waitForPickupRow(catalog);
    assert.notEqual(fresh.id, pickup.id);
    const promoted = await catalog.get(pickup.id);
    assert.ok(promoted?.agentProvider);
    await assert.rejects(promoted!.respondQuestion("anything"));
  } finally {
    await catalog.dispose();
  }
});

test("a failed warm-up surfaces could-not-resume and a later prompt retries", async () => {
  const home = path.join(scratch, "state-pickup-warmfail");
  const agents: FakeAgent[] = [];
  const source = new FakeSource([externalClaude("external-claude-5", project)]);
  const store = new OwnedSessionStore(home);
  const catalog = new OwnedSessionCatalog(config(home), factory(agents, true), store, source);
  try {
    const pickup = await openPickup(catalog);
    await pickup.respondQuestion("1 · Claude · project · refactor the parser");
    await pickup.respondQuestion("Pick up here");
    await settle(() => notified(pickup, "Claude session could not resume"));
    // The handoff already happened — the record and row survive the failed
    // resume, and the next prompt retries the attach.
    assert.equal(store.list()[0]?.id, pickup.id);
    const adopted = await catalog.get(pickup.id);
    assert.ok(adopted);
    await assert.rejects(adopted.prompt("hello"), /resume failed/);
    assert.equal(agents.length, 2);
  } finally {
    await catalog.dispose();
  }
});

test("a reconnect after handoff lands on the adopted session, and dispose tears it down", async () => {
  const home = path.join(scratch, "state-pickup-reconnect");
  const agents: FakeAgent[] = [];
  const source = new FakeSource([externalClaude("external-claude-6", project)]);
  const store = new OwnedSessionStore(home);
  const catalog = new OwnedSessionCatalog(config(home), factory(agents), store, source);
  const pickup = await openPickup(catalog);
  await pickup.respondQuestion("1 · Claude · project · refactor the parser");
  await pickup.respondQuestion("Pick up here");
  await settle(() => agents.length === 1);
  const picksBefore = asked(pickup, "pick");

  const adopted = await catalog.get(pickup.id);
  assert.ok(adopted);
  await adopted.onConnect?.();
  adopted.replayPending?.();
  // No picker, no "Picking up…", no second child — an ordinary remembered open.
  assert.equal(asked(pickup, "pick"), picksBefore);
  assert.equal(notified(pickup, "Picking up…"), false);
  assert.equal(agents.length, 1);

  await catalog.dispose();
  assert.equal(agents[0]?.disposed, 1);
  const leasePath = path.join(home, "sessions", pickup.id.slice("owned:".length), "lease.json");
  assert.equal(fs.existsSync(leasePath), false);
});

test("adoptable() offers nothing when the provider binary is missing, and adopt() refuses", async () => {
  const home = path.join(scratch, "state-pickup-no-provider");
  const source = new FakeSource([externalClaude("external-claude-4", project)]);
  const grokOnly = config(home);
  grokOnly.providers = { grok: providerConfig };
  const catalog = new OwnedSessionCatalog(grokOnly, factory([]), new OwnedSessionStore(home), source);
  try {
    assert.deepEqual(await catalog.adoptable(true), []);
    assert.equal(source.candidateCalls, 0);
    await assert.rejects(catalog.adopt(externalClaude("external-claude-4", project)), /Claude is unavailable/);
    // No candidates ⇒ the probe never creates the row.
    const rows = await catalog.list();
    assert.equal(rows.find((row) => row.title === PICKUP_TITLE), undefined);
  } finally {
    await catalog.dispose();
  }
});
