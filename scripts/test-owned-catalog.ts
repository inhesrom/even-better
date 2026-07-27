import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo } from "../src/owned-agent.js";
import type { OwnedConfig, OwnedProviderConfig } from "../src/owned-config.js";
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

/** The list minus the wizard row, which the catalog now always offers so agent and
 *  directory can be chosen before any prompt exists. Setup rows carry no
 *  `agentProvider`; remembered ones always do. */
const agentRows = (items: SessionDescriptor[]): SessionDescriptor[] =>
  items.filter((item) => item.agentProvider !== undefined);

const wizardRows = (items: SessionDescriptor[]): SessionDescriptor[] =>
  items.filter((item) => item.agentProvider === undefined);

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
    assert.equal(after.length, 2);
    assert.ok(after.some((item) => item.id === live.id));
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
