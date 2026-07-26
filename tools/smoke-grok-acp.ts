import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.GROK_SMOKE !== "1") {
  console.log("Grok ACP smoke: skipped (set GROK_SMOKE=1 to make one real model request)");
  process.exit(0);
}

const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const token = "grok-smoke-local-token";
const marker = "GROK_SMOKE_OK";

interface SessionResponse {
  sessions: Array<{ id: string; provider: string; agentProvider?: string; cwd: string }>;
}

interface PromptResponse {
  sessionId: string;
}

interface Message {
  type?: string;
  text?: string;
  success?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

interface MessagesResponse {
  messages: Message[];
  state: string;
}

async function waitForServer(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("smoke server stdout unavailable");
  stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Grok startup timed out")), timeoutMs);
    const onData = (chunk: string): void => {
      buffer += chunk;
      const match = buffer.match(/Local\s+:\s+(http:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const onExit = (): void => finish(new Error("Grok startup failed"));
    const finish = (error?: Error, value?: string): void => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value!);
    };
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function api<T>(base: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Grok smoke API failed with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function waitForResult(base: string, sessionId: string): Promise<MessagesResponse> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const body = await api<MessagesResponse>(
      base,
      `/messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (body.messages.some((message) => message.type === "result")) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Grok prompt timed out");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Grok server did not shut down cleanly"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const cwd = await mkdtemp(path.join(os.tmpdir(), "even-better-grok-smoke-"));
// Its own state directory: the smoke must never touch the user's remembered
// sessions or contend for their leases.
const stateDir = await mkdtemp(path.join(os.tmpdir(), "even-better-grok-smoke-state-"));
const env = { ...process.env };
delete env.MUX;
const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
  cwd: projectRoot,
  env: {
    ...env,
    SOURCE: "owned",
    WORKSPACE_ROOTS: cwd,
    EVEN_BETTER_HOME: stateDir,
    BRIDGE_TOKEN: token,
    BIND_HOST: "local",
    PORT: "0",
    QR: "0",
    LOG: "off",
    STREAM_TICK_MS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
// Always drain stderr, but never echo it: the smoke output is structural only.
child.stderr?.resume();

try {
  const base = await waitForServer(child);
  // Owned mode starts empty; the stock launcher's first prompt (no sessionId)
  // creates the setup session, which retains that prompt and dispatches it once
  // an agent and directory are chosen.
  assert.deepEqual((await api<SessionResponse>(base, "/sessions")).sessions, []);
  const created = await api<PromptResponse>(base, "/prompt", {
    method: "POST",
    body: JSON.stringify({ text: `Reply exactly ${marker}. Do not use tools.` }),
  });
  const sessionId = created.sessionId;
  assert.match(sessionId, /^owned:/);
  for (const answer of ["Grok", cwd]) {
    await api(base, "/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer }),
    });
  }
  const sessions = await api<SessionResponse>(base, "/sessions");
  assert.equal(sessions.sessions.length, 1);
  const session = sessions.sessions[0];
  // "codex" is the stock app's compatibility identity; the real agent is Grok.
  assert.equal(session.provider, "codex");
  assert.equal(session.agentProvider, "grok");
  assert.equal(session.cwd, cwd);
  assert.equal(session.id, sessionId);
  const completed = await waitForResult(base, session.id);
  const result = completed.messages.find((message) => message.type === "result");
  const prose = completed.messages
    .filter((message) => message.type === "text_delta")
    .map((message) => message.text ?? "")
    .join("");
  assert.equal(result?.success, true);
  assert.match(prose, new RegExp(marker));
  assert.ok((result?.inputTokens ?? -1) >= 0);
  assert.ok((result?.outputTokens ?? -1) >= 0);
  assert.equal(completed.state, "idle");
  await stop(child);
  console.log(`Grok ACP smoke: passed (${process.platform}, Node ${process.versions.node})`);
} finally {
  await stop(child).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}
