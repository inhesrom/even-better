import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { GrokOwnedAgent } from "../src/grok-owned-agent.js";
import type { OwnedAgentEvent, OwnedAgentSink } from "../src/owned-agent.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), "even-better-grok-owned-"));
after(() => rm(cwd, { recursive: true, force: true }));

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

test("Grok owned adapter maps ACP prose, tools, permissions, questions, usage, and interruption", async () => {
  const sink = new Sink();
  const agent = new GrokOwnedAgent({
    bin: fakeGrok,
    cwd,
    env: { ...process.env, FAKE_GROK_SCENARIO: "mixed" },
    startupTimeoutMs: 2_000,
    cancelTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
  });
  try {
    const started = await agent.start(sink);
    assert.equal(started.nativeSessionId, "fake-session");
    assert.deepEqual(sink.events[0], { type: "model", model: "fake-grok-model" });
    await agent.prompt("inspect");
    await waitFor(sink, "permission");
    await agent.respondPermission("allow");
    await waitFor(sink, "question");
    await agent.respondQuestion("Deep");
    const result = await waitFor(sink, "result");
    assert.ok(result.type === "result" && result.success && result.usage?.inputTokens === 11);
    assert.ok(sink.events.some((event) => event.type === "tool" && event.status === "completed" && event.output === "preferred raw output"));

    await agent.prompt("[hang]");
    await waitFor(sink, "tool", 3);
    await agent.interrupt();
    const interrupted = await waitFor(sink, "result", 2);
    assert.ok(interrupted.type === "result" && interrupted.cancelled);
  } finally {
    await agent.dispose();
  }
});

for (const mode of ["load", "resume"] as const) {
  test(`Grok owned adapter resumes with ACP session/${mode}`, async () => {
    const sink = new Sink();
    const agent = new GrokOwnedAgent({
      bin: fakeGrok,
      cwd,
      env: { ...process.env, FAKE_GROK_RESUME_MODE: mode },
      startupTimeoutMs: 2_000,
      cancelTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
    });
    try {
      const started = await agent.start(sink, `remembered-${mode}`);
      assert.equal(started.nativeSessionId, `remembered-${mode}`);
      assert.ok(!sink.events.some((event) => event.type === "prose" && event.text.includes("historical native replay")));
    } finally {
      await agent.dispose();
    }
  });
}
