import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
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
}

function assertNoAgentSetup(sessions: SessionItem[]): void {
  assert.ok(sessions.every((session) => session.title !== "＋ Agent setup"));
}

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

function startServer(workspace: string, home: string, scenario = "mixed"): ChildProcess {
  const env = { ...process.env };
  delete env.MUX;
  return spawn(process.execPath, ["--import", tsxLoader, serverEntry], {
    cwd: workspace,
    env: {
      ...env,
      SOURCE: "owned",
      WORKSPACE_ROOTS: workspace,
      EVEN_BETTER_HOME: home,
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
    assert.deepEqual(initial.sessions, []);
    assertNoAgentSetup(initial.sessions);

    const created = await api<{ sessionId: string; provider: string }>(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: null, provider: "codex", cwd: "/ignored", text: "first prompt" }),
    }, 202);
    const sessionId = created.sessionId;
    assert.match(sessionId, /^owned:/);
    assert.equal(created.provider, "codex");

    assert.equal((await firstSseEvent(base, sessionId)).type, "user_question");
    const premature = await api<{ error: string }>(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, text: "must not be retained" }),
    }, 409);
    assert.match(premature.error, /finish choosing an agent and directory/);

    const settingUp = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(settingUp.sessions.length, 1);
    assert.equal(settingUp.sessions[0]?.id, sessionId);
    assert.equal(settingUp.sessions[0]?.title, "Setting up agent session…");
    assertNoAgentSetup(settingUp.sessions);
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: "Grok" }),
    });
    await waitForMessage(base, sessionId, "user_question", 2);
    const replayedDirectory = await firstSseEvent(base, sessionId);
    assert.equal(replayedDirectory.type, "user_question");
    assert.match(replayedDirectory.toolUseId ?? "", /:directory$/);
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: workspace }),
    });

    // The directory answer returns as soon as the wizard accepts it — holding the POST
    // open for the whole provider startup is what made the phone wait tens of seconds
    // with nothing on screen. Promotion lands in the background, with the first
    // prompt's user_prompt right behind it.
    await waitForMessage(base, sessionId, "user_prompt");
    const configured = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(configured.sessions.length, 1);
    assertNoAgentSetup(configured.sessions);
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
    assert.deepEqual(
      pending.filter((message) => message.type === "user_prompt").map((message) => message.text),
      ["first prompt"],
    );
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
    assertNoAgentSetup(titled.sessions);
    assert.equal(titled.sessions.find((session) => session.id === sessionId)?.title, `Grok · ${path.basename(workspace)} · first prompt`);

    await stop(child);
    child = startServer(workspace, home);
    base = await waitForServer(child);
    const afterRestart = await api<{ sessions: SessionItem[] }>(base, "/sessions?provider=codex");
    assert.equal(afterRestart.sessions.length, 1);
    assertNoAgentSetup(afterRestart.sessions);
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
    assertNoAgentSetup(listed.sessions);

    // The restart retains the newest prompt, and the session still completes normally.
    await answer(base, sessionId, "Grok");
    await answer(base, sessionId, workspace);
    await waitFor("the retained first prompt", () => stream.events.some((m) => m.type === "user_prompt"));
    assert.deepEqual(
      stream.events.filter((m) => m.type === "user_prompt").map((m) => m.text),
      ["second attempt"],
    );
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
