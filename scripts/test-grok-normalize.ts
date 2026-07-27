import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  normalizeSessionNotification,
  parseQuestionRequest,
  parseXaiTurnCompleted,
  promptMeta,
  terminalSummary,
} from "../src/grok-acp-normalize.js";
import { redactGrokDiagnostic } from "../src/grok-redact.js";

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "session-1", update };
}

test("normalizer preserves tool patch presence and readable content", () => {
  const initial = normalizeSessionNotification(notification({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Edit file",
    kind: "edit",
    status: "in_progress",
    rawInput: { path: "a.ts" },
  }));
  assert.equal(initial.kind, "tool");
  if (initial.kind !== "tool") return;
  assert.equal(initial.patch.initial, true);
  assert.ok(initial.patch.present.includes("rawInput"));

  const patch = normalizeSessionNotification(notification({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    content: [
      { type: "diff", path: "a.ts", oldText: "old\n", newText: "new\nline\n" },
      { type: "content", content: { type: "text", text: "done" } },
    ],
  }));
  assert.equal(patch.kind, "tool");
  if (patch.kind !== "tool") return;
  assert.deepEqual(patch.patch.present.sort(), ["content", "status"]);
  assert.match(patch.patch.content ?? "", /a\.ts \(\+2 -1\)/);
  assert.match(patch.patch.content ?? "", /done/);

  const clears = normalizeSessionNotification(notification({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    title: null,
    kind: null,
    status: null,
    content: null,
    rawOutput: null,
  }));
  assert.equal(clears.kind, "tool");
  if (clears.kind !== "tool") return;
  assert.equal(clears.patch.title, null);
  assert.equal(clears.patch.kind, null);
  assert.equal(clears.patch.status, null);
  assert.equal(clears.patch.content, null);
  assert.equal(clears.patch.rawOutput, null);
});

test("normalizer reports unsupported binary content without forwarding it", () => {
  const update = normalizeSessionNotification(notification({
    sessionUpdate: "agent_message_chunk",
    content: { type: "image", data: "very-secret-pixels", mimeType: "image/png" },
  }));
  assert.deepEqual(update, { kind: "unsupported_content", contentType: "image", bytes: 18 });
});

test("Grok question parser rejects ambiguous forms and retains previews", () => {
  const parsed = parseQuestionRequest({
    sessionId: "session-1",
    toolCallId: "question-1",
    mode: "plan",
    questions: [{
      question: "Pick modes",
      multiSelect: true,
      options: [{ label: "Safe", description: "No writes", preview: "Read only" }],
    }],
  });
  assert.equal(parsed?.mode, "plan");
  assert.equal(parsed?.questions[0]?.multiSelect, true);
  assert.equal(parsed?.questions[0]?.options[0]?.preview, "Read only");
  assert.equal(parseQuestionRequest({ sessionId: "x", questions: [] }), null);
  assert.equal(parseQuestionRequest({
    sessionId: "x",
    toolCallId: "y",
    mode: "default",
    questions: [
      { question: "same", options: [] },
      { question: "same", options: [] },
    ],
  }), null);
});

test("Grok terminal extension and stop reasons normalize deterministically", () => {
  assert.deepEqual(parseXaiTurnCompleted({
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: "prompt-1",
      cancellationCategory: "MidTurnAbort",
      usage: { inputTokens: 5, outputTokens: 3, numTurns: 2 },
    },
  }), {
    promptId: "prompt-1",
    cancellationCategory: "MidTurnAbort",
    usage: { inputTokens: 5, outputTokens: 3, turns: 2 },
  });
  assert.deepEqual(terminalSummary("end_turn", undefined), { success: true, fallback: "Completed." });
  assert.deepEqual(terminalSummary("cancelled", "MidTurnAbort"), {
    success: false,
    fallback: "Interrupted.",
  });
  assert.deepEqual(promptMeta({
    stopReason: "end_turn",
    usage: { inputTokens: 8, outputTokens: 4 },
  }), {
    usage: { inputTokens: 8, outputTokens: 4, turns: 1, cumulative: false },
  });
});

test("Grok diagnostic redaction removes credentials, identity, queries, and local paths", () => {
  const redacted = redactGrokDiagnostic(
    "\u001b[31mBearer secret XAI_API_KEY=xai-abcdefgh user@example.com "
      + "https://example.test/path?user_code=abcd&token=efgh "
      + "/home/person/private/file /tmp/grok-secret account_id=acct-1\u001b[0m",
  );
  assert.doesNotMatch(redacted, /secret|abcdefgh|user@example|abcd|efgh|person|grok-secret|acct-1/);
  assert.match(redacted, /REDACTED/);
});
