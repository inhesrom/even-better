import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const provider = process.argv[2];
if (provider !== "claude" && provider !== "codex") {
  throw new Error("Usage: tsx tools/smoke-owned-agent.ts <claude|codex>");
}
const gate = `${provider.toUpperCase()}_SMOKE`;
if (process.env[gate] !== "1") {
  console.log(`${provider} owned smoke: skipped (set ${gate}=1 to make one real model request)`);
  process.exit(0);
}

const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const token = `${provider}-owned-smoke-local-token`;
const marker = `${provider.toUpperCase()}_OWNED_SMOKE_OK`;

interface WireMessage {
  type?: string;
  text?: string;
  success?: boolean;
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
  if (!response.ok) throw new Error(`${provider} owned smoke API failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitForServer(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("smoke server stdout unavailable");
  stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`${provider} startup timed out`)), 30_000);
    const onData = (chunk: string): void => {
      buffer += chunk;
      const match = buffer.match(/Local\s+:\s+(http:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const onExit = (): void => finish(new Error(`${provider} server startup failed`));
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

async function waitForType(base: string, sessionId: string, type: string, timeoutMs = 120_000): Promise<WireMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await api<{ messages: WireMessage[] }>(base, `/messages?sessionId=${encodeURIComponent(sessionId)}`);
    if (body.messages.some((message) => message.type === type)) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${provider} owned smoke timed out waiting for ${type}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${provider} server did not shut down cleanly`));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const cwd = await mkdtemp(path.join(os.tmpdir(), `even-better-${provider}-smoke-`));
const childEnv = { ...process.env };
delete childEnv.MUX;
const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
  cwd: projectRoot,
  env: {
    ...childEnv,
    SOURCE: "owned",
    WORKSPACE_ROOTS: cwd,
    BRIDGE_TOKEN: token,
    BIND_HOST: "local",
    PORT: "0",
    QR: "0",
    LOG: "off",
    STREAM_TICK_MS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr?.resume();

try {
  const base = await waitForServer(child);
  const listed = await api<{ sessions: Array<{ title: string }> }>(base, "/sessions");
  assert.ok(listed.sessions.every((session) => session.title !== "＋ Agent setup"));
  const created = await api<{ sessionId: string }>(base, "/prompt", {
    method: "POST",
    body: JSON.stringify({
      sessionId: null,
      provider: "codex",
      cwd: "/ignored/by-owned-mode",
      text: `Reply exactly ${marker}. Do not use tools.`,
    }),
  });
  await api(base, "/question-response", {
    method: "POST",
    body: JSON.stringify({ sessionId: created.sessionId, answer: provider === "claude" ? "Claude" : "Codex" }),
  });
  await api(base, "/question-response", {
    method: "POST",
    body: JSON.stringify({ sessionId: created.sessionId, answer: cwd }),
  });
  const messages = await waitForType(base, created.sessionId, "result");
  const prose = messages.filter((message) => message.type === "text_delta").map((message) => message.text ?? "").join("");
  const result = messages.find((message) => message.type === "result");
  assert.equal(result?.success, true);
  assert.match(prose, new RegExp(marker));
  console.log(`${provider} owned smoke: passed (${process.platform}, Node ${process.versions.node})`);
} finally {
  await stop(child).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true });
}
