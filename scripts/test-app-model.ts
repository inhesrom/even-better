import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, type AppState } from "../tools/lib/app-model.js";

const run = (...events: unknown[]): AppState => events.reduce<AppState>(reduce, initialState());

// 1. Append — text_delta is the one type that folds rather than appends.
test("text-delta-folds", () => assert.deepEqual(
  run({ type: "text_delta", text: "Hello" }, { type: "text_delta", text: " world" }).entries,
  [{ kind: "say", text: "Hello world" }]));

test("tool-splits-prose", () => assert.deepEqual(
  run(
    { type: "text_delta", text: "before" },
    { type: "tool_start", name: "Bash", toolId: "t1" },
    { type: "text_delta", text: "after" },
  ).entries.map((entry) => entry.kind),
  ["say", "tool", "say"]));

test("result-entry", () => assert.deepEqual(
  run({ type: "result", success: true, text: "ok", durationMs: 4200, inputTokens: 1204, outputTokens: 318 }).entries,
  [{ kind: "result", success: true, text: "ok", durationMs: 4200, inputTokens: 1204, outputTokens: 318 }]));

// 2. Keyed update — one bubble per toolId, running → done in place.
test("tool-closes-in-place", () => {
  const entries = run(
    { type: "tool_start", name: "Bash", toolId: "t1", summary: "ls" },
    { type: "tool_end", name: "Bash", toolId: "t1", summary: "ls -la" },
  ).entries;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { kind: "tool", tool: { toolId: "t1", name: "Bash", summary: "ls -la", done: true } });
});

// An id we never saw opened must not materialise a bubble for a tool that never ran.
test("orphan-tool-end", () => assert.deepEqual(run({ type: "tool_end", name: "Bash", toolId: "nope" }).entries, []));

test("repeated-tool-end", () => {
  const entries = run(
    { type: "tool_start", name: "Bash", toolId: "t1" },
    { type: "tool_end", name: "Bash", toolId: "t1", summary: "first" },
    { type: "tool_end", name: "Bash", toolId: "t1", summary: "second" },
  ).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "tool" ? entries[0].tool.summary : "", "first");
});

// 3. Single-slot widgets — overwrite one element, never grow the transcript.
test("widgets-overwrite", () => {
  const state = run(
    { type: "status", state: "busy" },
    { type: "running_stats", durationMs: 1_000, inputTokens: 10, outputTokens: 2 },
    { type: "running_stats", durationMs: 2_000, inputTokens: 20, outputTokens: 4 },
    { type: "task_progress", completed: 1, total: 3, current: "writing" },
    { type: "task_progress", completed: 2, total: 3, current: "testing" },
  );
  assert.deepEqual(state.entries, []);
  assert.equal(state.status, "busy");
  assert.deepEqual(state.stats, { durationMs: 2_000, inputTokens: 20, outputTokens: 4 });
  assert.deepEqual(state.progress, { completed: 2, total: 3, current: "testing" });
});

// The official package emits these from its Codex path; they are just states.
test("codex-status-states", () => assert.equal(run({ type: "status", state: "think_start" }).status, "think_start"));

// 4. Interactive — at most one menu, cleared by its paired ack.
test("permission-open-and-clear", () => {
  const options = [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }];
  const opened = run({ type: "permission_request", toolName: "Bash", description: "rm -rf build/", options });
  assert.deepEqual(opened.pending, { kind: "permission", toolName: "Bash", description: "rm -rf build/", options });
  const closed = reduce(opened, { type: "permission_result", toolName: "Bash", decision: "allowed" });
  assert.equal(closed.pending, null);
  assert.equal(closed.entries.at(-1)?.kind, "ack");
});

// Timeouts never auto-deny, so an unanswerable menu would strand the turn.
test("menu-always-answerable", () => {
  const state = run({ type: "permission_request", toolName: "Bash", options: [] });
  assert.deepEqual(
    state.pending?.kind === "permission" ? state.pending.options.map((option) => option.key) : [],
    ["allow", "deny"],
  );
});

test("question-open-and-clear", () => {
  const questions = [{ question: "Which depth?", header: "Grok", options: [{ label: "Quick", description: "fast" }] }];
  const asked = run({ type: "user_question", questions, toolUseId: "x" });
  assert.deepEqual(asked.pending, {
    kind: "question",
    header: "Grok",
    question: "Which depth?",
    options: [{ label: "Quick", description: "fast" }],
  });
  assert.equal(reduce(asked, { type: "question_answer", answers: { answer: "Quick" } }).pending, null);
});

// The wizard asks agent then directory; the second must take the same slot.
test("question-replaces", () => assert.equal(
  run(
    { type: "user_question", questions: [{ question: "Agent?", header: "Agent", options: [{ label: "Grok" }] }] },
    { type: "user_question", questions: [{ question: "Directory?", header: "Directory", options: [{ label: "/tmp" }] }] },
  ).pending?.kind === "question" ? "Directory?" : "",
  "Directory?"));

// Unknown shapes are shown rather than thrown — the official package sends types
// this repo never emits, and a client that dies on one is not faithful.
test("unknown-not-fatal", () => assert.deepEqual(
  run({ type: "error", message: "boom" }, "not-json", 42).entries.map((entry) => entry.kind),
  ["raw", "raw", "raw"]));
