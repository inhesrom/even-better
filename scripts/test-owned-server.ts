import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const token = "owned-server-test-token";

interface SessionItem {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  agentProvider?: string;
  status: string;
}

interface WireMessage {
  id: number;
  type?: string;
  text?: string;
  provider?: string;
  agentProvider?: string;
  toolUseId?: string;
  title?: string;
  state?: string;
}

/** Exactly one wizard row is always offered so agent and directory can be chosen
 *  before any prompt exists. Setup rows carry no `agentProvider`. */
const MANAGE_TITLE = "＋ Manage sessions";
const PICKUP_TITLE = "＋ Pick up session";

/** Setup rows only. The manage and pickup rows are synthetic too, so they also
 *  have no `agentProvider`, but neither is a way into the wizard. */
function assertOneWizardRow(sessions: SessionItem[], title?: string): void {
  const wizard = sessions.filter(
    (session) => session.agentProvider === undefined
      && session.title !== MANAGE_TITLE
      && session.title !== PICKUP_TITLE,
  );
  assert.equal(wizard.length, 1, `expected one wizard row, got ${JSON.stringify(sessions.map((s) => s.title))}`);
  if (title !== undefined) assert.equal(wizard[0]?.title, title);
}

const manageRow = (sessions: SessionItem[]): SessionItem | undefined =>
  sessions.find((session) => session.title === MANAGE_TITLE);

const pickupRow = (sessions: SessionItem[]): SessionItem | undefined =>
  sessions.find((session) => session.title === PICKUP_TITLE);

const agentRows = (sessions: SessionItem[]): SessionItem[] =>
  sessions.filter((session) => session.agentProvider !== undefined);

/** user_prompt texts minus the wizard's render prime (SETUP_PRIME_TEXT). */
const promptTexts = (messages: WireMessage[]): Array<string | undefined> =>
  messages.filter((message) => message.type === "user_prompt" && message.text !== "New agent session")
    .map((message) => message.text);

async function waitForServer(child: ChildProcess): Promise<string> {
  const stream = child.stdout;
  assert.ok(stream);
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for server:\n${output}`)), 5_000);
    const onData = (chunk: string): void => {
      output += chunk;
      const match = output.match(/Local\s+:\s+(http:\/\/[^\s]+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Server exited during startup with ${code}:\n${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
    };
    stream.on("data", onData);
    child.once("exit", onExit);
  });
}

async function api<T>(base: string, route: string, init?: RequestInit, expected = 200): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  assert.equal(response.status, expected, body.error ?? JSON.stringify(body));
  return body;
}

async function waitForMessage(base: string, id: string, type: string, count = 1): Promise<WireMessage[]> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const body = await api<{ messages: WireMessage[] }>(base, `/messages?sessionId=${encodeURIComponent(id)}`);
    const matches = body.messages.filter((message) => message.type === type);
    if (matches.length >= count) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

/** Wait for a real prompt. Counting `user_prompt` frames would be satisfied by the
 *  wizard's render primes, which arrive on every stream open. */
async function waitForTaskPrompt(base: string, id: string): Promise<WireMessage[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = await api<{ messages: WireMessage[] }>(base, `/messages?sessionId=${encodeURIComponent(id)}`);
    if (promptTexts(body.messages).length > 0) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a task prompt");
}

async function firstSseEvent(base: string, id: string): Promise<WireMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const response = await fetch(`${base}/api/events?sessionId=${encodeURIComponent(id)}&token=${token}`, {
    signal: controller.signal,
  });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before an event arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6)) as WireMessage;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}

/** An SSE stream that stays open, so a test can assert the server never ended it.
 *  `firstSseEvent` closes after one frame and cannot see that. */
interface OpenStream {
  events: WireMessage[];
  ended: boolean;
  close: () => void;
}

async function openStream(base: string, id: string): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?sessionId=${encodeURIComponent(id)}&token=${token}`, {
    signal: controller.signal,
  });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const stream: OpenStream = { events: [], ended: false, close: () => controller.abort() };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) stream.events.push(JSON.parse(data.slice(6)) as WireMessage);
        }
      }
    } catch {
      // aborted by close(), or the server ended the stream
    }
    stream.ended = true;
  })();
  return stream;
}

async function waitFor(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const asked = (stream: OpenStream, step: string): number =>
  stream.events.filter((message) => message.toolUseId?.endsWith(`:${step}`)).length;

/** ADR 0005: a synthetic row's first question must not arrive in the same frame as
 *  the stream opening — the app silently drops it, which is what ADR 0004 measured
 *  and mistook for "rows cannot host a menu". The prime goes first, the question
 *  follows. Both the wizard and the manage row depend on this, so `step` names
 *  which one is under test. */
async function assertPrimedQuestion(base: string, id: string, step = "provider"): Promise<void> {
  const stream = await openStream(base, id);
  try {
    await waitFor(`the primed ${step} question`, () => asked(stream, step) >= 1);
    const types = stream.events.map((event) => event.type);
    assert.equal(types[0], "user_prompt", `expected the prime first, got ${types.join(", ")}`);
    assert.ok(
      types.indexOf("user_question") > types.indexOf("user_prompt"),
      `expected the question after the prime, got ${types.join(", ")}`,
    );
  } finally {
    stream.close();
  }
}

async function answer(base: string, sessionId: string, value: string): Promise<void> {
  await api(base, "/question-response", {
    method: "POST",
    body: JSON.stringify({ sessionId, answer: value }),
  });
}

async function newSessionPrompt(base: string, text: string): Promise<string> {
  const created = await api<{ sessionId: string }>(base, "/prompt", {
    method: "POST",
    // Exactly what the stock ＋ New Session row sends.
    body: JSON.stringify({ sessionId: null, cwd: null, provider: "codex", text }),
  }, 202);
  return created.sessionId;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not shut down")), 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function startServer(
  workspace: string,
  home: string,
  scenario = "mixed",
  overrides: NodeJS.ProcessEnv = {},
): ChildProcess {
  const env = { ...process.env };
  delete env.MUX;
  return spawn(process.execPath, ["--import", tsxLoader, serverEntry], {
    cwd: workspace,
    env: {
      ...env,
      SOURCE: "owned",
      WORKSPACE_ROOTS: workspace,
      EVEN_BETTER_HOME: home,
      // Hermetic agent homes: session discovery scans these, and inheriting the
      // developer's real ~/.claude and ~/.codex would conjure a pickup row from
      // whatever sessions happen to live on the machine running the tests.
      CLAUDE_CONFIG_DIR: path.join(workspace, ".claude-home"),
      CODEX_HOME: path.join(workspace, ".codex-home"),
      CLAUDE_BIN: path.join(workspace, "missing-claude"),
      CODEX_BIN: path.join(workspace, "missing-codex"),
      GROK_BIN: fakeGrok,
      FAKE_GROK_SCENARIO: scenario,
      BRIDGE_TOKEN: token,
      BIND_HOST: "local",
      PORT: "0",
      QR: "0",
      LOG: "off",
      STREAM_TICK_MS: "1",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("the stock null-session prompt runs after owned setup and resumes with Codex compatibility", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-server-"));
  const home = path.join(workspace, ".even-better-state");
  let child = startServer(workspace, home);
  try {
    let base = await waitForServer(child);
    assert.equal((await api<{ provider: string }>(base, "/info")).provider, "codex");

    const initial = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.deepEqual(agentRows(initial.sessions), []);
    assertOneWizardRow(initial.sessions, "＋ Agent setup");
    // Openable before anything is spoken: this is the reordering.
    await assertPrimedQuestion(base, initial.sessions[0]!.id);

    const created = await api<{ sessionId: string; provider: string }>(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: null, provider: "codex", cwd: "/ignored", text: "first prompt" }),
    }, 202);
    const sessionId = created.sessionId;
    assert.match(sessionId, /^owned:/);
    assert.equal(created.provider, "codex");

    await assertPrimedQuestion(base, sessionId);
    const premature = await api<{ error: string }>(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, text: "must not be retained" }),
    }, 409);
    assert.match(premature.error, /finish choosing an agent and directory/);

    const settingUp = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(settingUp.sessions.length, 1);
    assert.equal(settingUp.sessions[0]?.id, sessionId);
    // The ＋ New Session prompt takes over the wizard row rather than adding a second.
    assertOneWizardRow(settingUp.sessions, "Setting up · first prompt");
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: "Grok" }),
    });
    await waitForMessage(base, sessionId, "user_question", 2);
    // A reconnect mid-wizard replays the outstanding question, primed the same way —
    // the app needs the prime again on every stream, not just the first.
    const reconnect = await openStream(base, sessionId);
    try {
      await waitFor("the replayed directory question", () => asked(reconnect, "directory") >= 1);
      assert.equal(reconnect.events[0]?.type, "user_prompt");
      assert.match(
        reconnect.events.find((event) => event.type === "user_question")?.toolUseId ?? "",
        /:directory$/,
      );
    } finally {
      reconnect.close();
    }
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: workspace }),
    });

    // The directory answer returns as soon as the wizard accepts it — holding the POST
    // open for the whole provider startup is what made the phone wait tens of seconds
    // with nothing on screen. Promotion lands in the background, with the first
    // prompt's user_prompt right behind it.
    await waitForTaskPrompt(base, sessionId);
    const configured = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(agentRows(configured.sessions).length, 1);
    // Promotion frees the wizard slot, so a fresh way in is offered again.
    assertOneWizardRow(configured.sessions, "＋ Agent setup");
    const remembered = configured.sessions.find((session) => session.id === sessionId);
    assert.equal(remembered?.provider, "codex");
    assert.equal(remembered?.agentProvider, "grok");
    assert.equal(remembered?.cwd, workspace);
    assert.equal(remembered?.title, `Grok · ${path.basename(workspace)} · first prompt`);
    assert.deepEqual(await api<{ history: Array<{ role: string; text: string }> }>(base, `/sessions/${encodeURIComponent(sessionId)}/history`), {
      history: [{ role: "user", text: "first prompt" }],
    });

    const pending = await waitForMessage(base, sessionId, "permission_request");
    assert.ok(pending.every((message) => !message.provider || message.provider === "codex"));
    assert.deepEqual(promptTexts(pending), ["first prompt"]);
    await api(base, "/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, decision: "allow" }),
    });
    await waitForMessage(base, sessionId, "user_question", 4);
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: "Deep" }),
    });
    const completed = await waitForMessage(base, sessionId, "result");
    const result = completed.find((message) => message.type === "result");
    assert.equal(result?.provider, "codex");
    assert.equal(result?.agentProvider, "grok");
    assert.deepEqual(await api<{ history: Array<{ role: string; text: string }> }>(base, `/sessions/${encodeURIComponent(sessionId)}/history`), {
      history: [
        { role: "user", text: "first prompt" },
        { role: "assistant", text: "I’ll inspect the workspace.\n\nFinished the Deep pass." },
      ],
    });
    const titled = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assertOneWizardRow(titled.sessions, "＋ Agent setup");
    assert.equal(titled.sessions.find((session) => session.id === sessionId)?.title, `Grok · ${path.basename(workspace)} · first prompt`);

    await stop(child);
    child = startServer(workspace, home);
    base = await waitForServer(child);
    const afterRestart = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(agentRows(afterRestart.sessions).length, 1);
    // The wizard row is catalog state: minted fresh on restart, never persisted.
    assertOneWizardRow(afterRestart.sessions, "＋ Agent setup");
    assert.equal(afterRestart.sessions.find((session) => session.id === sessionId)?.agentProvider, "grok");
    const status = await firstSseEvent(base, sessionId);
    assert.equal(status.type, "status");
    assert.equal(status.provider, "codex");
    assert.equal(status.agentProvider, "grok");
    const history = await api<{ history: Array<{ role: string; text: string }> }>(base, `/sessions/${encodeURIComponent(sessionId)}/history`);
    assert.equal(history.history[0]?.text, "first prompt");
  } finally {
    try {
      await stop(child);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test("a repeated ＋ New Session prompt reuses the session instead of closing its stream", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-restart-"));
  const home = path.join(workspace, ".even-better-state");
  const child = startServer(workspace, home);
  try {
    const base = await waitForServer(child);
    const sessionId = await newSessionPrompt(base, "first attempt");
    const stream = await openStream(base, sessionId);
    await waitFor("the agent question", () => asked(stream, "provider") >= 1);

    // The ＋ row is voice-first and always sends a null-session prompt, so a re-tap
    // (or a retry) arrives as a second one. That used to dispose the pending setup,
    // and dispose() res.end()s exactly this stream — the wizard just went dead.
    const again = await newSessionPrompt(base, "second attempt");
    assert.equal(again, sessionId, "a restarted setup must keep its public id");
    await waitFor("the re-asked agent question", () => asked(stream, "provider") >= 2);
    assert.equal(stream.ended, false, "the phone's SSE stream must survive a restarted setup");

    const listed = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.id, sessionId);
    assertOneWizardRow(listed.sessions, "Setting up · second attempt");

    // The restart retains the newest prompt, and the session still completes normally.
    await answer(base, sessionId, "Grok");
    await answer(base, sessionId, workspace);
    await waitFor("the retained first prompt", () => promptTexts(stream.events).length > 0);
    assert.deepEqual(promptTexts(stream.events), ["second attempt"]);
    assert.equal(stream.ended, false);
    stream.close();
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a failed provider start reopens as one retry, never the whole wizard", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-retry-"));
  const home = path.join(workspace, ".even-better-state");
  // Every start fails authentication — the shape of the observed incident, where a
  // provider that kept timing out walked the glasses through agent + directory on
  // every attempt, four full cycles in two minutes.
  const child = startServer(workspace, home, "auth-error");
  try {
    const base = await waitForServer(child);
    const sessionId = await newSessionPrompt(base, "start something");
    const stream = await openStream(base, sessionId);
    await waitFor("the agent question", () => asked(stream, "provider") >= 1);
    await answer(base, sessionId, "Grok");
    await answer(base, sessionId, workspace);

    await waitFor("the retry question", () => asked(stream, "retry") >= 1);
    assert.ok(stream.events.some((m) => (m as { title?: string }).title === "Grok could not start"));
    assert.equal(asked(stream, "provider"), 1, "the agent question must not be re-asked");
    assert.equal(asked(stream, "directory"), 1, "the directory question must not be re-asked");

    // Retry re-runs both retained answers with a single tap.
    await answer(base, sessionId, "Retry");
    await waitFor("the second retry question", () => asked(stream, "retry") >= 2);
    assert.equal(asked(stream, "provider"), 1);
    assert.equal(asked(stream, "directory"), 1);
    assert.ok(stream.events.some((m) => (m as { message?: string }).message?.includes("(attempt 2)")));

    // Changing the agent is the only route back to the agent question.
    await answer(base, sessionId, "Change agent");
    await waitFor("the reopened agent question", () => asked(stream, "provider") >= 2);
    assert.equal(stream.ended, false);
    stream.close();
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

// End-to-end over the real HTTP + SSE surface: a spoken command must reach the
// provider as its slash form, and an ambiguous one must come back as a menu the
// phone can answer. The bridge unit tests cover the state machine; this covers the
// wiring from POST /prompt through the catalog to the wire.
test("a spoken slash command dispatches, and an ambiguous one asks first", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-commands-"));
  const home = path.join(workspace, ".even-better-state");
  const child = startServer(workspace, home);
  try {
    const base = await waitForServer(child);
    const sessionId = await newSessionPrompt(base, "first prompt");
    await firstSseEvent(base, sessionId);
    await answer(base, sessionId, "Grok");
    await waitForMessage(base, sessionId, "user_question", 2);
    await answer(base, sessionId, workspace);
    // The first prompt runs once the provider is up, and the fixture blocks it on a
    // permission and a question before finishing. Clear both so the session is idle.
    await waitForMessage(base, sessionId, "permission_request");
    await api(base, "/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, decision: "allow" }),
    });
    // Three so far: the provider question, the directory question, and the fixture's.
    await waitForMessage(base, sessionId, "user_question", 3);
    await answer(base, sessionId, "Deep");
    await waitForMessage(base, sessionId, "result");

    const stream = await openStream(base, sessionId);
    try {
      await api(base, "/prompt", {
        method: "POST",
        body: JSON.stringify({ sessionId, text: "slash gril" }),
      }, 202);
      // "gril" prefixes both /grill and /grill-me, so nothing may be dispatched yet.
      await waitFor("the command picker", () => asked(stream, "pick") === 1);
      const picker = stream.events.find((message) => message.toolUseId?.endsWith(":pick"));
      assert.match(picker?.toolUseId ?? "", /^owned-command:/);

      await answer(base, sessionId, "/grill-me");
      // Picking dispatches inside the turn the prompt already opened, so the fixture's
      // ordinary turn script runs and one result closes the whole interaction.
      await waitFor("the command turn to start", () =>
        stream.events.some((message) => message.type === "permission_request"));
      await api(base, "/permission-response", {
        method: "POST",
        body: JSON.stringify({ sessionId, decision: "allow" }),
      });
      await waitFor("the provider's own question", () =>
        stream.events.filter((message) => message.type === "user_question").length === 2);
      await answer(base, sessionId, "Deep");
      await waitFor("the command turn to close", () => stream.events.some((message) => message.type === "result"));
      assert.equal(stream.events.filter((message) => message.type === "result").length, 1);
      assert.equal(stream.ended, false);
    } finally {
      stream.close();
    }
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the manage row deletes a remembered session over SSE, and DELETE does the same", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-manage-"));
  const home = path.join(workspace, ".even-better-state");
  const child = startServer(workspace, home);
  try {
    const base = await waitForServer(child);

    // Nothing remembered yet, so there is nothing to manage.
    const empty = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(manageRow(empty.sessions), undefined);

    const doomed = await newSessionPrompt(base, "delete me");
    await answer(base, doomed, "Grok");
    await answer(base, doomed, workspace);
    await waitForMessage(base, doomed, "status", 1);

    const listed = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    const manager = manageRow(listed.sessions);
    assert.ok(manager, `expected a manage row, got ${JSON.stringify(listed.sessions.map((s) => s.title))}`);
    // The manage row is the wizard's twin: same prime, same deferral, same guard.
    await assertPrimedQuestion(base, manager.id, "pick");

    const stream = await openStream(base, manager.id);
    try {
      await waitFor("the delete menu", () => asked(stream, "pick") >= 1);
      const pick = stream.events.find((event) => event.toolUseId?.endsWith(":pick")) as
        | { questions?: Array<{ options: Array<{ label: string }> }> }
        | undefined;
      const label = pick?.questions?.[0]?.options[0]?.label;
      assert.ok(label, "expected a session option");

      await answer(base, manager.id, label);
      await waitFor("the confirm menu", () => asked(stream, "confirm") >= 1);
      await answer(base, manager.id, "Delete forever");
      await waitFor(
        "the deletion notification",
        () => stream.events.some((event) => event.title === "Session deleted"),
      );
    } finally {
      stream.close();
    }

    const afterDelete = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.deepEqual(agentRows(afterDelete.sessions), []);
    // Gone from the catalog entirely, not just from the list.
    await api<{ error: string }>(base, `/sessions/${encodeURIComponent(doomed)}/history`, {}, 404);

    // The same catalog.forget() path, reached over HTTP instead of the glasses.
    const second = await newSessionPrompt(base, "delete me too");
    await answer(base, second, "Grok");
    await answer(base, second, workspace);
    await waitForMessage(base, second, "status", 1);
    const watching = await openStream(base, second);
    try {
      await api(base, `/sessions/${encodeURIComponent(second)}`, { method: "DELETE" });
      // dropSession() ends the phone's stream; that is user-visible, so assert it.
      await waitFor("the deleted session's stream to end", () => watching.ended);
    } finally {
      watching.close();
    }
    const afterHttp = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.deepEqual(agentRows(afterHttp.sessions), []);

    const missing = await api<{ error: string }>(base, "/sessions/owned:00000000-0000-4000-8000-000000000000", { method: "DELETE" }, 404);
    assert.match(missing.error, /not found/i);
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the pickup row adopts a terminal codex session, and the adopted row resumes on open", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-pickup-"));
  const home = path.join(workspace, ".even-better-state");
  const folder = path.basename(workspace);
  const uuid = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918";

  // A rollout exactly where a terminal `codex` session would have left one, inside
  // the hermetic CODEX_HOME startServer points the server at.
  const day = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const rolloutDir = path.join(
    workspace, ".codex-home", "sessions",
    String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()),
  );
  await mkdir(rolloutDir, { recursive: true });
  await writeFile(path.join(rolloutDir, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { session_id: uuid, cwd: workspace, originator: "codex_cli_rs" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "refactor the reader" } }),
    "",
  ].join("\n"));

  let child = startServer(workspace, home, "mixed", { CODEX_BIN: fakeCodex });
  try {
    let base = await waitForServer(child);

    // The row appears once the fire-and-forget discovery probe lands.
    let row: SessionItem | undefined;
    const deadline = Date.now() + 5_000;
    for (;;) {
      row = pickupRow((await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex")).sessions);
      if (row) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for the pickup row");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // The pickup row is the wizard's twin: same prime, same deferral, same guard.
    await assertPrimedQuestion(base, row.id, "pick");

    const stream = await openStream(base, row.id);
    try {
      await waitFor("the pickup menu", () => asked(stream, "pick") >= 1);
      const pick = stream.events.find((event) => event.toolUseId?.endsWith(":pick")) as
        | { toolUseId?: string; questions?: Array<{ options: Array<{ label: string }> }> }
        | undefined;
      assert.match(pick?.toolUseId ?? "", /^owned-pickup:/);
      const label = pick?.questions?.[0]?.options[0]?.label;
      assert.equal(label, `1 · Codex · ${folder} · refactor the reader`);

      await answer(base, row.id, label!);
      await waitFor("the confirm menu", () => asked(stream, "confirm") >= 1);
      await answer(base, row.id, "Pick up here");
      await waitFor(
        "the adoption notification",
        () => stream.events.some((event) => event.title === "Session picked up"),
      );
      // Promote-in-place: the open stream gets the same idle frame the wizard's
      // promote emits, and the handoff must never end the phone's stream.
      await waitFor(
        "the promote status frame",
        () => stream.events.some((event) =>
          event.type === "status" && event.state === "idle" && event.agentProvider === "codex"),
      );
      assert.equal(stream.ended, false, "the handoff must not end the phone's stream");
    } finally {
      stream.close();
    }

    // The pickup row itself became the remembered session: same public id,
    // codex identity, the transcript's cwd and first user message as excerpt.
    const listed = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    const adopted = agentRows(listed.sessions).find((session) => session.agentProvider === "codex");
    assert.ok(adopted, `expected an adopted codex row, got ${JSON.stringify(listed.sessions.map((s) => s.title))}`);
    assert.equal(adopted.id, row.id);
    assert.equal(adopted.cwd, workspace);
    assert.equal(adopted.status, "idle");
    assert.equal(adopted.title, `Codex · ${folder} · refactor the reader`);

    // The warm-up already spawned the fixture and resumed the external thread
    // id; the prompt rides that bridge and runs the ordinary approval →
    // question → result turn.
    await api(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: adopted.id, text: "continue where I left off" }),
    }, 202);
    await waitForMessage(base, adopted.id, "permission_request");
    await api(base, "/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId: adopted.id, decision: "allow" }),
    });
    await waitForMessage(base, adopted.id, "user_question");
    await answer(base, adopted.id, "Deep");
    await waitForMessage(base, adopted.id, "result");

    // Across a restart the adopted row survives as a remembered session, and the
    // pickup row does not come back: its only candidate is now remembered.
    await stop(child);
    child = startServer(workspace, home, "mixed", { CODEX_BIN: fakeCodex });
    base = await waitForServer(child);
    const afterRestart = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(afterRestart.sessions.find((session) => session.id === adopted.id)?.agentProvider, "codex");
    for (let poll = 0; poll < 4; poll++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const again = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
      assert.equal(pickupRow(again.sessions), undefined, "the pickup row must stay hidden once its candidate is remembered");
    }
  } finally {
    try {
      await stop(child);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});
