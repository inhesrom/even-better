import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const token = "fake-server-token";

interface SessionResponse {
  sessions: Array<{ id: string; provider: string; cwd: string; status: string }>;
}

interface BufferedMessage {
  id: number;
  type?: string;
  success?: boolean;
  state?: string;
}

interface MessagesResponse {
  messages: BufferedMessage[];
  state: string;
  provider: string | null;
}

async function waitForServer(child: ChildProcess, timeoutMs = 6_000): Promise<string> {
  const stream = child.stdout;
  if (!stream) throw new Error("Server stdout is unavailable");
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server startup:\n${output}`));
    }, timeoutMs);
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

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  assert.ok(response.ok, `${response.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

async function waitForMessage(
  base: string,
  sessionId: string,
  type: string,
  count = 1,
  timeoutMs = 5_000,
): Promise<MessagesResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await request<MessagesResponse>(
      base,
      `/messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (body.messages.filter((message) => message.type === type).length >= count) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function reconnectEvents(base: string, sessionId: string): Promise<BufferedMessage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const response = await fetch(
    `${base}/api/events?sessionId=${encodeURIComponent(sessionId)}&needReplay=true&token=${token}`,
    { signal: controller.signal },
  );
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: BufferedMessage[] = [];
  let buffer = "";
  try {
    while (!events.some((event) => event.type === "result") || !events.some((event) => event.type === "status" && event.state === "idle")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)) as BufferedMessage);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
  return events;
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

test("Grok source serves one complete Even-app protocol session", async () => {
  const grokCwd = await mkdtemp(path.join(os.tmpdir(), "even-better-grok-server-test-"));
  const env = { ...process.env };
  delete env.MUX;
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: process.cwd(),
    env: {
      ...env,
      SOURCE: "grok",
      GROK_BIN: fakeGrok,
      GROK_CWD: grokCwd,
      FAKE_GROK_SCENARIO: "mixed",
      BRIDGE_TOKEN: token,
      BIND_HOST: "local",
      PORT: "0",
      QR: "0",
      LOG: "off",
      STREAM_TICK_MS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  try {
    const base = await waitForServer(child);
    const sessions = await request<SessionResponse>(base, "/sessions");
    assert.equal(sessions.sessions.length, 1);
    const session = sessions.sessions[0];
    assert.equal(session.provider, "grok");
    assert.equal(session.status, "idle");
    assert.equal(session.cwd, grokCwd);

    await request(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, text: "Inspect the workspace" }),
    });
    await waitForMessage(base, session.id, "permission_request");
    await request(base, "/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, decision: "allow" }),
    });
    await waitForMessage(base, session.id, "user_question");
    await request(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        answer: JSON.stringify({ "Which depth should I use?": "Quick" }),
      }),
    });
    const completed = await waitForMessage(base, session.id, "result");
    assert.equal(completed.provider, "grok");
    assert.equal(completed.state, "idle");
    assert.equal(completed.messages.find((message) => message.type === "result")?.success, true);
    assert.ok(completed.messages.some((message) => message.type === "tool_start"));
    assert.ok(completed.messages.some((message) => message.type === "tool_end"));

    await request(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, text: "Deny this tool" }),
    });
    await waitForMessage(base, session.id, "permission_request", 2);
    await request(base, "/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, decision: "deny" }),
    });
    const denied = await waitForMessage(base, session.id, "result", 2);
    assert.equal(denied.messages.filter((message) => message.type === "result")[1]?.success, true);

    await request(base, "/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, text: "[hang] until interrupted" }),
    });
    await waitForMessage(base, session.id, "tool_start", 3);
    await request(base, "/interrupt", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    });
    const interrupted = await waitForMessage(base, session.id, "result", 3);
    assert.equal(interrupted.messages.filter((message) => message.type === "result")[2]?.success, false);
    assert.equal(interrupted.state, "idle");

    const replay = await reconnectEvents(base, session.id);
    assert.ok(replay.some((message) => message.type === "result"));
    assert.ok(replay.some((message) => message.type === "status" && message.state === "idle"));
  } finally {
    try {
      await stop(child);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    } finally {
      await rm(grokCwd, { recursive: true, force: true });
    }
    const unexpectedStderr = stderr
      .split("\n")
      .filter((line) => line && !/^\[sse\] socket error session=grok:[0-9a-f-]+ code=ECONNRESET$/.test(line));
    assert.deepEqual(unexpectedStderr, [], stderr);
  }
});
