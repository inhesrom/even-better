// Interactive even-terminal protocol client: connects to a running bridge the
// way the stock app does, renders the four consumption semantics, and answers
// menus — so a whole turn, including the owned setup wizard, can be driven with
// no glasses.
//
// This stands in for the *glasses*, not for the agents: by default it launches a
// real server and talks to whatever Claude/Codex/Grok is installed. `--fake` is
// the opt-out, for working on even-better's own plumbing without model calls.
//
// Usage: tsx tools/app-tui.ts [cli args…]      launch a real server, then attach
//        tsx tools/app-tui.ts <port> <token>   attach to a server already running
//        tsx tools/app-tui.ts --fake [grok|owned]   fixtures only, no model calls

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { initialState, reduce, type AppState, type Entry, type Pending } from "./lib/app-model.js";

const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fakeGrok = fileURLToPath(new URL("../scripts/fixtures/fake-grok.mjs", import.meta.url));
const fakeCodex = fileURLToPath(new URL("../scripts/fixtures/fake-codex.mjs", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

const SIM_TOKEN = "even-better-sim-token";
const USAGE = `usage: pnpm sim [cli args…]          launch a real server, then attach
       pnpm sim <port> <token>       attach to a server already running
       pnpm sim --fake [grok|owned]  fixtures only, no model calls

Stands in for the glasses, not for the agents. Extra arguments in the first form
go to src/cli.ts, so --source and --workspace-root work as they do for pnpm start.`;
const NEW_SESSION = "＋ New Session";
const CUSTOM_ANSWER = "(type a custom answer)";
// The server advertises `retry: 2000`; reconnecting on the same cadence keeps
// the gap behaviour in docs/PROTOCOL.md observable rather than papered over.
const RETRY_MS = 2_000;

const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";
const CLEAR = "\x1b[H\x1b[2J";

const tty = process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text: string): string => paint("2", text);
const bold = (text: string): string => paint("1", text);
const red = (text: string): string => paint("31", text);
const green = (text: string): string => paint("32", text);
const yellow = (text: string): string => paint("33", text);
const cyan = (text: string): string => paint("36", text);

interface SessionRow {
  id: string;
  title?: string;
  cwd?: string;
  provider?: string;
  agentProvider?: string;
  status?: string;
}

interface Server {
  base: string;
  stop: () => Promise<void>;
}

let base = "";
let token = "";
let server: Server | null = null;

let mode: "picker" | "session" = "picker";
let rows: SessionRow[] = [];
let current: SessionRow | null = null;
let sessionId = "";
let pick = 0;
let sel = 0;
let lastPending: Pending | null = null;

let state: AppState = initialState();
let connected = false;
let running = true;
let editing = false;
let answering = false;
let notice = "";
let abort = new AbortController();

// ── launching a server ─────────────────────────────────

/** Startup lines, before the alt screen takes over. */
const say = (line: string): void => void process.stdout.write(`${line}\n`);

/** Spawn a server and resolve once its startup banner names a local URL.
 *  `cleanup` runs after the child is signalled — only the fixture launcher needs
 *  it, to remove the scratch directory it created. */
async function launch(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  cleanup: () => Promise<void> = async () => {},
): Promise<Server> {
  const child = spawn(process.execPath, ["--import", tsxLoader, entry, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (diagnostics = (diagnostics + chunk).slice(-2000)));

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await cleanup();
  };

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const stream = child.stdout;
      if (!stream) return reject(new Error("Server stdout is unavailable"));
      stream.setEncoding("utf8");
      let output = "";
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for server:\n${output}${diagnostics}`)), 30_000);
      const onData = (chunk: string): void => {
        output += chunk;
        const match = output.match(/Local\s+:\s+(http:\/\/[^\s]+)/);
        if (match) finish(null, match[1]);
      };
      const onExit = (code: number | null): void =>
        finish(new Error(`Server exited with ${code}:\n${output}${diagnostics}`));
      const finish = (err: Error | null, value?: string): void => {
        clearTimeout(timer);
        stream.off("data", onData);
        child.off("exit", onExit);
        // Keep draining, or a full stdout pipe stalls the server.
        stream.resume();
        if (err) reject(err);
        else resolve(value ?? "");
      };
      stream.on("data", onData);
      child.once("exit", onExit);
    });
    return { base: url.replace(/\/$/, ""), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** The real thing: `src/cli.ts` owns every default — SOURCE, workspace roots,
 *  EVEN_BETTER_HOME, PATH provider discovery — so launching through it is
 *  identical to `pnpm start`. Only the three settings the sim must control are
 *  overridden; everything else, including the user's agent config and remembered
 *  sessions, is the real one. Extra arguments (`--source`, `--workspace-root`)
 *  pass straight through. */
async function startReal(args: string[]): Promise<Server> {
  return launch(cliEntry, args, { ...process.env, BRIDGE_TOKEN: SIM_TOKEN, PORT: "0", QR: "0" }, process.cwd());
}

/** Fixtures only, in a scratch directory, so no model is called and no real
 *  remembered session is touched. Claude is absent on purpose: it has no
 *  spawnable fixture — `ClaudeOwnedAgent` drives the in-process SDK, which
 *  launches the real CLI, so faking it means implementing the Claude Code
 *  stream-json control protocol. Use real mode to exercise Claude. */
async function startFake(kind: "grok" | "owned"): Promise<Server> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `even-better-sim-${kind}-`));
  const env: NodeJS.ProcessEnv = { ...process.env };
  // An ambient MUX would pull in a real multiplexer and defeat the point.
  delete env.MUX;
  const specific: NodeJS.ProcessEnv =
    kind === "grok"
      ? { SOURCE: "grok", GROK_CWD: workspace }
      : {
          SOURCE: "owned",
          WORKSPACE_ROOTS: workspace,
          EVEN_BETTER_HOME: path.join(workspace, ".even-better-state"),
          CLAUDE_BIN: path.join(workspace, "missing-claude"),
        };
  return launch(
    serverEntry,
    [],
    {
      ...env,
      ...specific,
      GROK_BIN: fakeGrok,
      CODEX_BIN: fakeCodex,
      FAKE_GROK_SCENARIO: "mixed",
      BRIDGE_TOKEN: SIM_TOKEN,
      BIND_HOST: "local",
      PORT: "0",
      QR: "0",
      LOG: "off",
      // STREAM_TICK_MS is deliberately left alone: watching real pacing is the
      // point of driving this by hand.
    },
    workspace,
    () => rm(workspace, { recursive: true, force: true }),
  );
}

// ── HTTP ───────────────────────────────────────────────

async function api<T>(route: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  return { status: response.status, body: body as T };
}

async function loadSessions(): Promise<void> {
  try {
    const { body } = await api<{ sessions?: SessionRow[]; error?: string }>("/sessions");
    rows = body.sessions ?? [];
    if (body.error) notice = body.error;
  } catch (err) {
    notice = (err as Error).message;
  }
  pick = Math.min(pick, rows.length);
  dirty = true;
}

// ── SSE ────────────────────────────────────────────────

async function streamOnce(needReplay: boolean): Promise<void> {
  abort = new AbortController();
  const query = `sessionId=${encodeURIComponent(sessionId)}${needReplay ? "&needReplay=true" : ""}&token=${encodeURIComponent(token)}`;
  // EventSource cannot set headers, so the stream authenticates by query param
  // exactly as the app does (docs/PROTOCOL.md §Auth).
  const response = await fetch(`${base}/api/events?${query}`, { signal: abort.signal });
  if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
  connected = true;
  dirty = true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      // `:ok`, `retry:` and `:heartbeat` carry no data line and are skipped here
      // the same way EventSource never dispatches them.
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        event = line.slice(6);
      }
      state = reduce(state, event);
      dirty = true;
    }
  }
}

async function streamLoop(): Promise<void> {
  // needReplay on first connect only — the app never re-asks on reconnect, so
  // asking every time would hide the gap described in docs/PROTOCOL.md.
  let needReplay = true;
  while (running) {
    try {
      await streamOnce(needReplay);
    } catch (err) {
      if (running) notice = `stream: ${(err as Error).message}`;
    }
    connected = false;
    needReplay = false;
    dirty = true;
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

// ── rendering ──────────────────────────────────────────

let dirty = true;

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

function entryLines(entry: Entry, width: number): string[] {
  switch (entry.kind) {
    case "prompt":
      return wrap(entry.text, width - 2).map((line, index) => cyan(`${index === 0 ? "› " : "  "}${line}`));
    case "say":
      return wrap(entry.text, width);
    case "tool": {
      const mark = entry.tool.done ? green("⏺") : yellow("⏺");
      const { name, summary } = entry.tool;
      const label = summary && summary !== name ? `${name}  ${summary}` : name;
      return [`${mark} ${clip(label, width - 12)} ${dim(entry.tool.done ? "[done]" : "[running]")}`];
    }
    case "result": {
      const head = entry.success ? green("● done") : red("● failed");
      const meta = dim(`${(entry.durationMs / 1000).toFixed(1)}s · ↑${entry.inputTokens} ↓${entry.outputTokens}`);
      const lines = [`${head} ${meta}`];
      if (!entry.success && entry.text) lines.push(...wrap(entry.text, width).map(red));
      return lines;
    }
    case "notification":
      return wrap(`! ${entry.title}: ${entry.message}`, width).map(yellow);
    case "ack":
      return [dim(`  ${clip(entry.text, width - 2)}`)];
    case "raw":
      return [dim(clip(entry.text, width))];
  }
}

function optionLabels(pending: Pending): string[] {
  return pending.kind === "permission"
    ? pending.options.map((option) => option.text)
    // The wizard's directory question also accepts any eligible descendant path,
    // not only the four it lists (src/owned-session-catalog.ts).
    : [...pending.options.map((option) => option.label), CUSTOM_ANSWER];
}

function menuLines(pending: Pending, width: number): string[] {
  const title = pending.kind === "permission" ? `▸ PERMISSION  ${pending.toolName}` : `▸ ${pending.header.toUpperCase()}`;
  const detail = pending.kind === "permission" ? pending.description : pending.question;
  const lines = [yellow(clip(title, width))];
  // Grok names the tool with its own summary, so the detail repeats the title.
  if (detail && !title.endsWith(detail)) lines.push(...wrap(detail, width - 4).map((line) => `    ${dim(line)}`));
  optionLabels(pending).forEach((label, index) => {
    lines.push(index === sel ? bold(`  ❯ ${clip(label, width - 4)}`) : `    ${dim(clip(label, width - 4))}`);
  });
  return lines;
}

function headerLine(width: number): string {
  const agent = current?.agentProvider ?? current?.provider ?? "?";
  // A full owned: UUID would push the status — the thing you actually watch —
  // off the end of the line.
  const where = current?.cwd ? path.basename(current.cwd) : sessionId.replace(/^owned:/, "").slice(0, 8);
  const link = connected ? green("●") : red("○");
  return bold(clip(`${link} even-better sim · ${agent} · ${where} · ${state.status}`, width));
}

function widgetLine(width: number): string {
  const parts: string[] = [];
  if (state.stats) {
    parts.push(`⏱ ${(state.stats.durationMs / 1000).toFixed(1)}s`);
    parts.push(`↑${state.stats.inputTokens} ↓${state.stats.outputTokens}`);
  }
  if (state.progress) parts.push(`[${state.progress.completed}/${state.progress.total}] ${state.progress.current}`);
  return dim(clip(parts.join("   "), width));
}

function hintLine(width: number): string {
  if (notice) return red(clip(notice, width));
  const keys = state.pending ? "↑↓ select · ⏎ answer · " : "";
  return dim(clip(`${keys}p prompt · i interrupt · r reconnect · q quit`, width));
}

function sessionLines(width: number, height: number): string[] {
  const menu = state.pending ? menuLines(state.pending, width) : [];
  const budget = Math.max(1, height - 3 - menu.length);
  const transcript = state.entries.flatMap((entry) => entryLines(entry, width));
  const shown = transcript.slice(-budget);
  const pad = Array<string>(Math.max(0, budget - shown.length)).fill("");
  return [headerLine(width), ...shown, ...pad, ...menu, widgetLine(width), hintLine(width)];
}

function pickerLines(width: number): string[] {
  const lines = [bold(clip(`even-better sim · ${base}`, width)), ""];
  // The ＋ row is drawn by the client: it never appears in /api/sessions and
  // selecting it makes no server request (docs/PROTOCOL.md §Provider).
  [NEW_SESSION, ...rows.map((row) => `${row.title ?? row.id}${row.status ? dim(`  (${row.status})`) : ""}`)].forEach(
    (label, index) => lines.push(index === pick ? bold(`  ❯ ${label}`) : `    ${dim(label)}`),
  );
  lines.push("", notice ? red(clip(notice, width)) : dim("↑↓ select · ⏎ open · q quit"));
  return lines;
}

function render(): void {
  if (state.pending !== lastPending) {
    lastPending = state.pending;
    sel = 0;
  }
  // `||`, not `??`: a pty with no size reports 0, which nullish coalescing
  // happily keeps — collapsing the frame to the Math.max floors.
  const width = Math.max(40, (process.stdout.columns || 80) - 1);
  const height = Math.max(12, process.stdout.rows || 24);
  const lines = mode === "picker" ? pickerLines(width) : sessionLines(width, height);
  process.stdout.write(`${CLEAR}${lines.slice(0, height).join("\n")}`);
  dirty = false;
}

// ── input ──────────────────────────────────────────────

async function readLine(prompt: string): Promise<string> {
  editing = true;
  process.stdin.off("data", onKey);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ALT_OFF);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let answer = "";
  try {
    answer = (await rl.question(prompt)).trim();
  } catch {
    answer = "";
  } finally {
    rl.close();
    process.stdout.write(ALT_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
    editing = false;
    dirty = true;
  }
  return answer;
}

async function sendPrompt(): Promise<void> {
  const text = await readLine("prompt> ");
  if (!text) return;
  const { status, body } = await api<{ error?: string }>("/prompt", {
    method: "POST",
    body: JSON.stringify({ sessionId, text }),
  });
  notice = status === 202 ? "" : body.error ?? `prompt failed (${status})`;
}

async function answerPending(): Promise<void> {
  const pending = state.pending;
  if (!pending || answering) return;
  answering = true;
  try {
    if (pending.kind === "permission") {
      const option = pending.options[sel];
      if (!option) return;
      // The menu answers with the option's key — allow / allowAlways / deny.
      const { body, status } = await api<{ error?: string }>("/permission-response", {
        method: "POST",
        body: JSON.stringify({ sessionId, decision: option.key }),
      });
      notice = status === 200 ? "" : body.error ?? `permission failed (${status})`;
      return;
    }
    const labels = optionLabels(pending);
    const choice = labels[sel];
    if (choice === undefined) return;
    // Questions answer with the option's label; normalizeAnswer takes it as-is.
    const value = choice === CUSTOM_ANSWER ? await readLine("answer> ") : choice;
    if (!value) return;
    const { body, status } = await api<{ error?: string }>("/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer: value }),
    });
    notice = status === 200 ? "" : body.error ?? `answer failed (${status})`;
  } finally {
    answering = false;
    dirty = true;
  }
}

async function openSession(): Promise<void> {
  if (pick === 0) {
    // The stock ＋ row's first prompt carries a null sessionId; the server
    // creates the session and answers 202 with its stable public id.
    const text = await readLine("first prompt> ");
    if (!text) return;
    const { status, body } = await api<{ sessionId?: string; provider?: string; agentProvider?: string; error?: string }>(
      "/prompt",
      { method: "POST", body: JSON.stringify({ sessionId: null, text }) },
    );
    if (status !== 202 || !body.sessionId) {
      notice = body.error ?? `create failed (${status})`;
      return;
    }
    sessionId = body.sessionId;
    current = { id: body.sessionId, provider: body.provider, agentProvider: body.agentProvider };
  } else {
    const row = rows[pick - 1];
    if (!row) return;
    sessionId = row.id;
    current = row;
  }
  notice = "";
  mode = "session";
  dirty = true;
  void streamLoop();
}

/** One read can carry several keystrokes, and an arrow is three bytes — so the
 *  chunk is split rather than treated as a single key. */
function keysIn(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; ) {
    const arrow = chunk.startsWith("\x1b[", i) && i + 2 < chunk.length;
    keys.push(chunk.slice(i, i + (arrow ? 3 : 1)));
    i += arrow ? 3 : 1;
  }
  return keys;
}

function onKey(chunk: string): void {
  for (const key of keysIn(chunk)) {
    // A prompt opened by an earlier key in this same chunk owns stdin now.
    if (editing) return;
    if (key === "\x03" || key === "q") {
      void shutdown();
      return;
    }
    const up = key === "\x1b[A" || key === "k";
    const down = key === "\x1b[B" || key === "j";
    const enter = key === "\r" || key === "\n";
    if (mode === "picker") {
      const count = rows.length + 1;
      if (up) pick = (pick - 1 + count) % count;
      else if (down) pick = (pick + 1) % count;
      else if (enter) void openSession();
    } else {
      const options = state.pending ? optionLabels(state.pending).length : 0;
      if (up && options) sel = (sel - 1 + options) % options;
      else if (down && options) sel = (sel + 1) % options;
      else if (enter) void answerPending();
      else if (key === "p") void sendPrompt();
      else if (key === "i") void api("/interrupt", { method: "POST", body: JSON.stringify({ sessionId }) });
      else if (key === "r") abort.abort();
    }
    dirty = true;
  }
}

// ── lifecycle ──────────────────────────────────────────

async function shutdown(code = 0): Promise<void> {
  running = false;
  abort.abort();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ALT_OFF);
  await server?.stop();
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fakeAt = args.indexOf("--fake");
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (fakeAt >= 0) {
    const kind = args[fakeAt + 1] === "owned" ? "owned" : "grok";
    say(`fake ${kind} server — fixtures only, no model calls`);
    if (kind === "owned") {
      say(dim("  wizard offers Codex and Grok; Claude has no fixture — use `pnpm sim` to exercise it"));
    }
    server = await startFake(kind);
    token = SIM_TOKEN;
  } else if (/^\d+$/.test(args[0] ?? "")) {
    const [port, argToken] = args;
    if (!argToken) {
      console.error(USAGE);
      process.exit(1);
    }
    base = `http://localhost:${port}`;
    token = argToken;
    say(`attached to ${base}`);
  } else {
    say(yellow("launching a real server — prompts reach real models and cost money"));
    say(dim("  a server already running? attach to it instead: pnpm sim <port> <token>"));
    server = await startReal(args);
    token = SIM_TOKEN;
  }
  if (server) {
    base = server.base;
    say(dim(`  ready · ${base}`));
  }

  await loadSessions();
  // The app re-lists every 10s; the picker is the only place that shows it.
  const poll = setInterval(() => {
    if (mode === "picker" && !editing) void loadSessions();
  }, 10_000);
  poll.unref();

  process.stdout.write(ALT_ON);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", onKey);
  // A closed terminal (SIGHUP) or a plain kill must still stop the spawned
  // server and remove its scratch directory. SIGKILL cannot be caught, so a
  // hard kill still orphans both.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown());
  }

  const frame = setInterval(() => {
    if (dirty && !editing) render();
  }, 50);
  frame.unref();
  render();
  await new Promise(() => {});
}

main().catch(async (err: Error) => {
  process.stdout.write(ALT_OFF);
  console.error(err.message);
  await server?.stop();
  process.exit(1);
});
