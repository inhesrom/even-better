// Unit tests for external-session discovery (the pickup row's data source).
// CLAUDE_CONFIG_DIR / CODEX_HOME are redirected to fixtures before any src
// import: findSessionFile/findCodexSessionFile read them per call, and the
// Agent SDK memoizes its config dir at first in-process use.

import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const scratch = mkdtempSync(path.join(os.tmpdir(), "even-better-discovery-"));
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, "claude-home");
process.env.CODEX_HOME = path.join(scratch, "codex-home");

const { ExternalSessionDiscovery, PICKUP_RECENCY_MS } = await import("../src/owned-discovery.js");
const { OwnedWorkspaceCatalog } = await import("../src/owned-workspaces.js");

const workspace = path.join(scratch, "workspace");
const project = path.join(workspace, "project");
const outside = mkdtempSync(path.join(os.tmpdir(), "even-better-outside-"));
mkdirSync(project, { recursive: true });
const workspaces = new OwnedWorkspaceCatalog([workspace]);
after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** A fixed clock keeps the recency window and the date-directory probing stable. */
const NOW = Date.now();

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** The same local-date spelling scanCodex probes for `at`. */
function dayDir(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return path.join(
    process.env.CODEX_HOME!,
    "sessions",
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  );
}

function writeRollout(at: number, uuid: string, lines: string[], name?: string): string {
  const dir = dayDir(at);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name ?? `rollout-2026-01-01T00-00-00-${uuid}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  utimesSync(file, new Date(at), new Date(at));
  return file;
}

function meta(uuid: string, cwd: string): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { session_id: uuid, cwd, originator: "codex_cli_rs", git: { branch: "feat/test-branch" } },
  });
}

test("codex scan reads session_meta, honours the window, eligibility, and newest-first order", async () => {
  writeRollout(NOW - 60_000, UUID_A, [
    meta(UUID_A, project),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "tune the filter" } }),
  ]);
  writeRollout(NOW - 120_000, UUID_B, [meta(UUID_B, project)]);
  // In today's directory but with an ancient mtime — excluded by the window.
  writeRollout(NOW - PICKUP_RECENCY_MS - 60_000, UUID_C, [meta(UUID_C, project)], `rollout-old-${UUID_C}.jsonl`);
  // Eligible-looking but outside WORKSPACE_ROOTS.
  writeRollout(NOW - 30_000, UUID_D, [meta(UUID_D, outside)]);
  // Junk line 0 and a non-rollout filename are skipped silently.
  writeRollout(NOW - 10_000, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ["not json"]);
  writeFileSync(path.join(dayDir(NOW), "notes.txt"), "irrelevant");

  const discovery = new ExternalSessionDiscovery(workspaces, { now: () => NOW });
  const found = await discovery.candidates(["codex"]);
  assert.deepEqual(
    found.map((candidate) => candidate.nativeSessionId),
    [UUID_A, UUID_B],
  );
  assert.equal(found[0]?.agentProvider, "codex");
  assert.equal(found[0]?.cwd, project);
  // The first user message and the session_meta git branch feed the menu.
  assert.equal(found[0]?.title, "tune the filter");
  assert.equal(found[0]?.branch, "feat/test-branch");
  assert.equal(found[1]?.title, "");
});

test("claude scan passes the terminal-parity options and filters stale, cwd-less, and ineligible sessions", async () => {
  const calls: Array<{ includeProgrammatic: boolean; limit: number }> = [];
  const discovery = new ExternalSessionDiscovery(workspaces, {
    now: () => NOW,
    listClaudeSessions: (options) => {
      calls.push(options);
      return Promise.resolve([
        { sessionId: UUID_A, summary: "fix the parser", gitBranch: "main", lastModified: NOW - 5_000, cwd: project },
        { sessionId: UUID_B, summary: "titled", customTitle: "my refactor", lastModified: NOW - 9_000, cwd: project },
        { sessionId: UUID_C, summary: "too old", lastModified: NOW - PICKUP_RECENCY_MS - 1, cwd: project },
        { sessionId: UUID_D, summary: "no cwd", lastModified: NOW - 1_000 },
        { sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", summary: "outside", lastModified: NOW - 1_000, cwd: outside },
      ]);
    },
  });
  const found = await discovery.candidates(["claude"]);
  assert.deepEqual(calls, [{ includeProgrammatic: false, limit: 200 }]);
  assert.deepEqual(
    found.map((candidate) => [candidate.nativeSessionId, candidate.title]),
    [
      [UUID_A, "fix the parser"],
      [UUID_B, "my refactor"], // customTitle wins over summary
    ],
  );
  assert.equal(found[0]?.branch, "main");
  assert.equal(found[1]?.branch, undefined);
});

test("candidates are TTL-cached, fresh bypasses, provider-set changes rescan, and a rejecting lister contributes []", async () => {
  let listed = 0;
  const discovery = new ExternalSessionDiscovery(workspaces, {
    now: () => NOW,
    listClaudeSessions: () => {
      listed++;
      return Promise.resolve([{ sessionId: UUID_A, summary: "s", lastModified: NOW, cwd: project }]);
    },
  });
  assert.deepEqual(await discovery.candidates([]), []);
  assert.equal(listed, 0);
  await discovery.candidates(["claude"]);
  await discovery.candidates(["claude"]);
  assert.equal(listed, 1);
  await discovery.candidates(["claude"], true);
  assert.equal(listed, 2);
  // A different provider set cannot be served from the cache.
  await discovery.candidates(["claude", "codex"]);
  assert.equal(listed, 3);

  const failing = new ExternalSessionDiscovery(workspaces, {
    now: () => NOW,
    listClaudeSessions: () => Promise.reject(new Error("store exploded")),
  });
  assert.deepEqual(await failing.candidates(["claude"]), []);
});

test("inspect reads codex model + first prompt, claude model + title, and reports a vanished transcript as null", async () => {
  const INSPECT_UUID = "12121212-1212-4121-8121-121212121212";
  const codexFile = writeRollout(NOW - 45_000, INSPECT_UUID, [
    meta(INSPECT_UUID, project),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "refactor the reader" } }),
  ]);
  const discovery = new ExternalSessionDiscovery(workspaces, { now: () => NOW });
  // The title is scan-populated; inspect passes it through as the first prompt.
  const codexCandidate = { agentProvider: "codex" as const, nativeSessionId: INSPECT_UUID, cwd: project, title: "refactor the reader", lastModifiedMs: NOW };
  assert.deepEqual(await discovery.inspect(codexCandidate), { model: "gpt-5.5", firstPrompt: "refactor the reader" });

  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-project");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    path.join(claudeDir, `${UUID_A}.jsonl`),
    JSON.stringify({ type: "assistant", message: { model: "claude-fable-5" } }) + "\n",
  );
  const claudeCandidate = { agentProvider: "claude" as const, nativeSessionId: UUID_A, cwd: project, title: "fix the parser", lastModifiedMs: NOW };
  assert.deepEqual(await discovery.inspect(claudeCandidate), { model: "claude-fable-5", firstPrompt: "fix the parser" });

  await rm(codexFile);
  assert.equal(await discovery.inspect(codexCandidate), null);
});
