import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { CodexOwnedAgent } from "../src/codex-owned-agent.js";
import type { OwnedAgentEvent, OwnedAgentSink } from "../src/owned-agent.js";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), "even-better-codex-owned-"));
after(() => rm(cwd, { recursive: true, force: true }));

function config(extra: NodeJS.ProcessEnv = {}) {
  return {
    bin: fakeCodex,
    env: { ...process.env, ...extra },
    startupTimeoutMs: 2_000,
    cancelTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
  };
}

class Sink implements OwnedAgentSink {
  events: OwnedAgentEvent[] = [];
  event(event: OwnedAgentEvent): void {
    this.events.push(event);
  }
}

async function waitFor(sink: Sink, type: OwnedAgentEvent["type"], count = 1): Promise<OwnedAgentEvent> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const matches = sink.events.filter((event) => event.type === type);
    if (matches.length >= count) return matches[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(sink.events)}`);
}

test("Codex app-server adapter streams tools, approvals, questions, plans, usage, and results", async () => {
  const sink = new Sink();
  const agent = new CodexOwnedAgent(cwd, config());
  try {
    const started = await agent.start(sink);
    assert.equal(started.nativeSessionId, "fake-thread");
    assert.deepEqual(sink.events[0], { type: "model", model: "fake-codex-model" });
    await agent.prompt("inspect");
    await waitFor(sink, "permission");
    await agent.respondPermission("allowAlways");
    await waitFor(sink, "question");
    await agent.respondQuestion("Deep");
    const result = await waitFor(sink, "result");
    assert.equal(result.type === "result" && result.success, true);
    assert.ok(sink.events.some((event) => event.type === "tool" && event.status === "running"));
    assert.ok(sink.events.some((event) => event.type === "tool" && event.status === "completed" && event.output === "hello"));
    assert.ok(sink.events.some((event) => event.type === "prose" && event.text === "Finished Deep."));
    assert.ok(sink.events.some((event) => event.type === "plan"));
    assert.ok(sink.events.some((event) => event.type === "usage" && event.usage.inputTokens === 13));

    await agent.prompt("hang");
    await waitFor(sink, "tool", 3);
    await agent.interrupt();
    const interrupted = await waitFor(sink, "result", 2);
    assert.equal(interrupted.type === "result" && interrupted.cancelled, true);
  } finally {
    await agent.dispose();
  }
});

test("Codex adapter rejects schema-incompatible CLI versions", async () => {
  const agent = new CodexOwnedAgent(cwd, config({ FAKE_CODEX_VERSION: "0.143.0" }));
  await assert.rejects(agent.start(new Sink()), /must be one of 0\.142\.5 or 0\.145\.0.*found 0\.143\.0/);
  await agent.dispose();
});

test("Codex adapter accepts both verified schemas and resumes the persisted thread", async () => {
  const sink = new Sink();
  const agent = new CodexOwnedAgent(cwd, config({ FAKE_CODEX_VERSION: "0.145.0" }));
  try {
    const started = await agent.start(sink, "remembered-thread");
    assert.equal(started.nativeSessionId, "remembered-thread");
    assert.equal(started.model, "fake-codex-model");
  } finally {
    await agent.dispose();
  }
});

test("Codex switches mode through thread/settings/update and reports the confirmation", async () => {
  const sink = new Sink();
  const agent = new CodexOwnedAgent(cwd, config());
  try {
    await agent.start(sink);
    await agent.setMode("plan");
    const planned = await waitFor(sink, "mode");
    assert.equal(planned.type === "mode" && planned.mode, "plan");

    await agent.setMode("auto");
    const auto = await waitFor(sink, "mode", 2);
    assert.equal(auto.type === "mode" && auto.mode, "auto");

    await agent.setMode("normal");
    const normal = await waitFor(sink, "mode", 3);
    assert.equal(normal.type === "mode" && normal.mode, "normal");
  } finally {
    await agent.dispose();
  }
});

// Plan is Codex's own collaboration mode plus a read-only sandbox. A CLI that does
// not know the first must still get the second: the sandbox is the half that
// actually stops an edit, so losing the whole switch would be the worse failure.
test("Codex falls back to the permission half when collaborationMode is unknown", async () => {
  const sink = new Sink();
  const agent = new CodexOwnedAgent(cwd, config({ FAKE_CODEX_NO_COLLAB: "1" }));
  try {
    await agent.start(sink);
    await agent.setMode("plan");
    const mode = await waitFor(sink, "mode");
    assert.equal(mode.type === "mode" && mode.mode, "plan");
  } finally {
    await agent.dispose();
  }
});
