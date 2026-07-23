import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { GrokSessionBridge } from "../src/grok-bridge.js";
import type { GrokConfig } from "../src/grok-config.js";
import { getMessages } from "../src/sse.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const testCwd = await mkdtemp(path.join(os.tmpdir(), "even-better-grok-test-"));
after(() => rm(testCwd, { recursive: true, force: true }));

interface WireMessage {
  id: number;
  type?: string;
  text?: string;
  success?: boolean;
  state?: string;
  decision?: string;
  toolId?: string;
  inputTokens?: number;
  outputTokens?: number;
  detail?: { output?: string };
}

function config(scenario: string): GrokConfig {
  return {
    bin: fakeGrok,
    cwd: testCwd,
    startupTimeoutMs: 3_000,
    cancelTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    env: { ...process.env, FAKE_GROK_SCENARIO: scenario },
  };
}

function messages(sessionId: string): WireMessage[] {
  return getMessages(sessionId, 0) as unknown as WireMessage[];
}

async function waitFor(
  sessionId: string,
  predicate: (message: WireMessage) => boolean,
  timeoutMs = 4_000,
): Promise<WireMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages(sessionId).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Grok event: ${JSON.stringify(messages(sessionId))}`);
}

async function waitForCount(
  sessionId: string,
  type: string,
  count: number,
  timeoutMs = 4_000,
): Promise<WireMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages(sessionId).filter((message) => message.type === type);
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} ${type} events`);
}

test("Grok ACP completes streaming, permission, question, tool, usage, and result", async () => {
  const bridge = new GrokSessionBridge(config("happy"));
  try {
    await bridge.start();
    const descriptor = await bridge.describe();
    assert.equal(descriptor.provider, "grok");
    assert.equal(descriptor.model, "fake-grok-model");

    await bridge.prompt("Inspect this workspace");
    await waitFor(bridge.id, (message) => message.type === "permission_request");
    assert.equal(bridge.state, "awaiting");
    await bridge.respondPermission("allow");
    await waitFor(bridge.id, (message) => message.type === "user_question");
    await bridge.respondQuestion("Deep");
    const result = await waitFor(bridge.id, (message) => message.type === "result");

    assert.equal(result.success, true);
    assert.equal(result.inputTokens, 11);
    assert.equal(result.outputTokens, 7);
    assert.equal(bridge.state, "idle");

    const all = messages(bridge.id);
    const toolStart = all.findIndex((message) => message.type === "tool_start");
    const permission = all.findIndex((message) => message.type === "permission_request");
    const permissionResult = all.findIndex((message) => message.type === "permission_result");
    const toolEnd = all.findIndex((message) => message.type === "tool_end");
    const question = all.findIndex((message) => message.type === "user_question");
    const answer = all.findIndex((message) => message.type === "question_answer");
    const resultIndex = all.findIndex((message) => message.type === "result");
    const idle = all.findIndex((message) => message.type === "status" && message.state === "idle");
    assert.ok(toolStart >= 0 && toolStart < permission);
    assert.ok(permission < permissionResult && permissionResult < toolEnd);
    assert.ok(toolEnd < question && question < answer);
    assert.ok(answer < resultIndex && resultIndex < idle);
    assert.equal(all[permissionResult]?.decision, "allowed");
    assert.equal(all[toolStart]?.toolId, all[toolEnd]?.toolId);
    assert.equal(all[toolEnd]?.detail?.output, "preferred raw output");
    assert.doesNotMatch(JSON.stringify(all), /fake-session|tool-1|question-1|allow-once/);
    assert.match(all.filter((message) => message.type === "text_delta").map((message) => message.text).join(""), /Finished the Deep pass/);

    await bridge.prompt("Inspect it again");
    await waitForCount(bridge.id, "permission_request", 2);
    await bridge.respondPermission("allow");
    await waitForCount(bridge.id, "user_question", 2);
    await bridge.respondQuestion("Quick");
    const results = await waitForCount(bridge.id, "result", 2);
    assert.equal(results[1]?.inputTokens, 11);
    assert.equal(results[1]?.outputTokens, 7);
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP interruption synthesizes tool completion and a failed result", async () => {
  const bridge = new GrokSessionBridge(config("hang"));
  try {
    await bridge.start();
    await bridge.prompt("Start a long operation");
    await waitFor(bridge.id, (message) => message.type === "tool_start");
    await bridge.interrupt();
    const result = await waitFor(bridge.id, (message) => message.type === "result");
    assert.equal(result.success, false);
    assert.equal(bridge.state, "idle");
    assert.ok(messages(bridge.id).some((message) => message.type === "tool_end"));
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP forwards an offered deny choice without silently allowing the tool", async () => {
  const bridge = new GrokSessionBridge(config("happy"));
  try {
    await bridge.start();
    await bridge.prompt("Inspect this workspace");
    await waitFor(bridge.id, (message) => message.type === "permission_request");
    await bridge.respondPermission("deny");
    const result = await waitFor(bridge.id, (message) => message.type === "result");
    assert.equal(result.success, true);
    const all = messages(bridge.id);
    assert.equal(all.find((message) => message.type === "permission_result")?.decision, "denied");
    assert.ok(all.some((message) => message.type === "tool_end"));
    assert.match(all.filter((message) => message.type === "text_delta").map((message) => message.text).join(""), /Permission denied/);
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP sequences multiple select and free-form questions into the official response", async () => {
  const bridge = new GrokSessionBridge(config("questions"));
  try {
    await bridge.start();
    await bridge.prompt("Ask several questions");
    await waitFor(bridge.id, (message) => message.type === "permission_request");
    await bridge.respondPermission("allow");
    await waitForCount(bridge.id, "user_question", 1);
    await bridge.respondQuestion("Deep");
    await waitForCount(bridge.id, "user_question", 2);
    await bridge.respondQuestion(JSON.stringify(["Quick", "Deep"]));
    await waitForCount(bridge.id, "user_question", 3);
    await bridge.respondQuestion("custom detail");
    const result = await waitFor(bridge.id, (message) => message.type === "result");
    assert.equal(result.success, true);
    assert.equal(messages(bridge.id).filter((message) => message.type === "question_answer").length, 3);
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP startup fails clearly when no headless authentication is available", async () => {
  const bridge = new GrokSessionBridge(config("missing-auth"));
  try {
    await assert.rejects(
      bridge.start(),
      /Grok authentication is unavailable\. Set XAI_API_KEY or run grok login/,
    );
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP rejects failed authentication and non-v1 protocol negotiation", async () => {
  const auth = new GrokSessionBridge(config("auth-error"));
  try {
    await assert.rejects(auth.start(), /Grok authentication failed for cached_token/);
  } finally {
    await auth.dispose();
  }
  const protocol = new GrokSessionBridge(config("protocol-v2"));
  try {
    await assert.rejects(protocol.start(), /required ACP v1 contract/);
  } finally {
    await protocol.dispose();
  }
});

test("Grok ACP keeps a healthy session usable after a sanitized prompt RPC failure", async () => {
  const bridge = new GrokSessionBridge(config("prompt-error"));
  try {
    await bridge.start();
    await bridge.prompt("fail once");
    const first = await waitForCount(bridge.id, "result", 1);
    assert.equal(first[0]?.success, false);
    await bridge.prompt("fail twice");
    const second = await waitForCount(bridge.id, "result", 2);
    assert.equal(second[1]?.success, false);
  } finally {
    await bridge.dispose();
  }
});

test("Grok ACP deduplicates protocol event IDs without text deduplication heuristics", async () => {
  const bridge = new GrokSessionBridge(config("duplicate"));
  try {
    await bridge.start();
    await bridge.prompt("duplicate frame test");
    await waitFor(bridge.id, (message) => message.type === "result");
    const prose = messages(bridge.id)
      .filter((message) => message.type === "text_delta")
      .map((message) => message.text)
      .join("");
    assert.equal(prose, "Only once.");
  } finally {
    await bridge.dispose();
  }
});

test("Malformed or wrong-session ACP makes the public session unavailable", async () => {
  for (const scenario of ["malformed", "wrong-session"]) {
    const bridge = new GrokSessionBridge(config(scenario));
    try {
      await bridge.start();
      await bridge.prompt("break the protocol");
      const result = await waitFor(bridge.id, (message) => message.type === "result");
      assert.equal(result.success, false);
      await assert.rejects(bridge.prompt("retry"), /session ended/);
    } finally {
      await bridge.dispose();
    }
  }
});

test("Grok ACP subprocess crashes become one failed result and an unavailable session", async () => {
  const bridge = new GrokSessionBridge(config("crash"));
  try {
    await bridge.start();
    await bridge.prompt("Crash now");
    const result = await waitFor(bridge.id, (message) => message.type === "result");
    assert.equal(result.success, false);
    await assert.rejects(bridge.prompt("retry"), /session ended/);
  } finally {
    await bridge.dispose();
  }
});
