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
import type { LiveSession, ProviderId } from "../src/session.js";
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

function config(homeDir: string, maxSessions = 6): OwnedConfig {
  return {
    homeDir,
    maxSessions,
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
  await settle();
  assert.equal(session.id, id);
  return session;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("the first null-session prompt creates a replayable setup session", async () => {
  const home = path.join(scratch, "state-prompt-setup");
  const catalog = new OwnedSessionCatalog(config(home), factory([]));
  try {
    assert.deepEqual(await catalog.list(), []);

    const session = await catalog.default();
    assert.ok(session);
    await session.prompt("first prompt");
    const publicId = session.id;

    assert.match(publicId, /^owned:/);
    assert.equal((await catalog.get(publicId))?.id, publicId);
    assert.equal((await catalog.list())[0]?.title, "Setting up agent session…");
    assert.ok((await catalog.list()).every((item) => item.title !== "＋ Agent setup"));

    await session.onConnect?.();
    session.replayPending?.();
    assert.ok(getMessages(publicId, 0).some((message) =>
      (message as { type?: string; toolUseId?: string }).type === "user_question"
      && (message as { toolUseId?: string }).toolUseId?.endsWith(":provider"),
    ));
    await assert.rejects(session.prompt("second prompt"), /finish choosing an agent and directory/);
  } finally {
    await catalog.dispose();
  }
});

test("abandoned setup sessions do not accumulate", async () => {
  const home = path.join(scratch, "state-setup-eviction");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  try {
    // Every null-session prompt used to mint a permanent map entry — nothing
    // ever removed one — and setups sort first in list(), so the phone's list
    // filled with "Setting up agent session…" rows.
    const ids: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await beginSetup(catalog, `abandoned ${attempt}`);
      ids.push(session.id);
    }
    const listed = await catalog.list();
    assert.equal(listed.length, 1, `expected one setup row, got ${JSON.stringify(listed.map((s) => s.title))}`);
    assert.equal(listed[0]?.title, "Setting up agent session…");
    // Only the newest survives; the abandoned ones are gone from the catalog.
    assert.equal(listed[0]?.id, ids[ids.length - 1]);
    for (const id of ids.slice(0, -1)) assert.equal(await catalog.get(id), undefined);

    // A completed setup is a remembered session and is never evicted this way.
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
    await settle();

    assert.equal(session.id, publicId);
    assert.equal(session.agentProvider, "claude");
    assert.deepEqual(agents[0]?.prompts, ["inspect this project"]);
    assert.equal(catalog.store.get(publicId)?.firstPrompt, "inspect this project");
    assert.deepEqual(await session.history?.(), [
      { role: "user", text: "inspect this project" },
      { role: "assistant", text: "reply to inspect this project" },
    ]);
    const descriptors = await catalog.list();
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0]?.id, publicId);
    assert.equal(descriptors[0]?.title, "Claude · project · inspect this project");
    assert.ok(descriptors.every((item) => item.title !== "＋ Agent setup"));
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
    assert.equal(session.agentProvider, undefined);
    assert.equal((await session.describe()).title, "Setting up agent session…");
    assert.ok(getMessages(session.id, 0).some((message) =>
      (message as { title?: string }).title === "Claude could not start",
    ));

    await session.respondQuestion("Claude");
    await session.respondQuestion(project);
    await settle();

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

test("restart lists remembered sessions only and lazily resumes their native context", async () => {
  const home = path.join(scratch, "state-main");
  const agents: FakeAgent[] = [];
  const catalog = new OwnedSessionCatalog(config(home), factory(agents));
  assert.deepEqual(await catalog.list(), []);
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
    const descriptors = await restored.list();
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0]?.id, publicId);
    assert.match(descriptors[0]?.title ?? "", /^Claude · project · first prompt$/);
    assert.ok(descriptors.every((session) => session.title !== "＋ Agent setup"));
    const remembered = await restored.get(publicId);
    assert.ok(remembered);
    assert.deepEqual(await remembered.history?.(), [
      { role: "user", text: "first prompt" },
      { role: "assistant", text: "reply to first prompt" },
    ]);
    await remembered.onConnect?.();
    assert.deepEqual(resumedAgents[0]?.resumes, ["native-claude-0"]);
    await remembered.prompt("continued");
    await settle();
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
    assert.equal(third.agentProvider, undefined);
    assert.equal(first.state, "busy");
    assert.equal(agents[2]?.disposed, 0);
    const afterFailedSetup = await catalog.list();
    assert.equal(afterFailedSetup.filter((session) => session.title === "Setting up agent session…").length, 1);
    assert.ok(afterFailedSetup.every((session) => session.title !== "＋ Agent setup"));
    assert.equal(afterFailedSetup[0]?.id, third.id);
    assert.ok(getMessages(third.id, 0).some((message) => (message as { title?: string }).title === "Agent process limit reached"));

    await first.interrupt();
    await settle();
    await first.prompt("await");
    assert.equal(first.state, "awaiting");
    await third.respondQuestion(project);
    assert.equal(third.agentProvider, undefined);
    assert.equal(agents[2]?.disposed, 0);
  } finally {
    await catalog.dispose();
  }
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
