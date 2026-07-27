import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo } from "../src/owned-agent.js";
import type { ProviderId } from "../src/session.js";

// The bridge reads its pacing at load, and these tests drain a whole turn.
process.env.STREAM_TICK_MS = "1";
const { OwnedSessionBridge } = await import("../src/owned-session-bridge.js");
const { getMessages } = await import("../src/sse.js");

class StubAgent implements OwnedAgent {
  sink: OwnedAgentSink | null = null;
  prompts: string[] = [];

  constructor(readonly provider: ProviderId = "claude", readonly cwd = "/tmp") {}

  start(sink: OwnedAgentSink): Promise<OwnedAgentStartInfo> {
    this.sink = sink;
    return Promise.resolve({ nativeSessionId: "native-stub", model: "stub-model" });
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    return Promise.resolve();
  }

  respondPermission(): Promise<void> {
    return Promise.resolve();
  }

  respondQuestion(): Promise<void> {
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitFor(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const typesOf = (id: string): (string | undefined)[] =>
  getMessages(id, 0).map((message) => (message as { type?: string }).type);

// The persistence hooks reach the session store's synchronous fs writes. A throw between
// `terminalizing = true` and the terminal `result` used to strand the turn outright: no
// result, no idle status, prompt() rejecting 409 and interrupt() returning early, for the
// life of the process. Losing a history line is the acceptable failure here.
test("a failing history write still ends the turn instead of wedging the session", async () => {
  const agent = new StubAgent();
  const id = "owned:test-persist-failure";
  let assistantCalls = 0;
  let activityCalls = 0;
  const bridge = new OwnedSessionBridge(id, agent, {
    model: () => {
      throw new Error("EACCES: permission denied, open 'metadata.json'");
    },
    assistant: () => {
      assistantCalls += 1;
      throw new Error("ENOSPC: no space left on device, write");
    },
    activity: () => {
      activityCalls += 1;
      throw new Error("EACCES: permission denied, open 'metadata.json'");
    },
  });

  await bridge.start();
  await bridge.prompt("do a thing");
  // The model hook runs inside the provider's event dispatch, so it must not throw back
  // into the agent either.
  assert.doesNotThrow(() => agent.sink?.event({ type: "model", model: "stub-model" }));
  agent.sink?.event({ type: "prose", text: "all done" });
  agent.sink?.event({ type: "result", success: true, text: "all done" });

  await waitFor("the turn to finish", () => bridge.state === "idle");
  assert.equal(assistantCalls, 1);
  assert.equal(activityCalls, 1);
  const types = typesOf(id);
  assert.ok(types.includes("result"), `no result emitted: ${JSON.stringify(types)}`);
  assert.equal(types.at(-1), "status");

  // The decisive part: the next turn still runs. A stuck `terminalizing` made this 409.
  await bridge.prompt("and another");
  assert.deepEqual(agent.prompts, ["do a thing", "and another"]);
  assert.equal(bridge.state, "busy");
  await bridge.dispose();
});

test("a healthy turn still reports history and activity exactly once", async () => {
  const agent = new StubAgent("codex");
  const id = "owned:test-persist-ok";
  const assistant: string[] = [];
  let activityCalls = 0;
  const bridge = new OwnedSessionBridge(id, agent, {
    assistant: (text) => assistant.push(text),
    activity: () => {
      activityCalls += 1;
    },
  });

  await bridge.start();
  await bridge.prompt("summarize");
  agent.sink?.event({ type: "prose", text: "the summary" });
  agent.sink?.event({ type: "result", success: true, text: "the summary" });

  await waitFor("the turn to finish", () => bridge.state === "idle");
  assert.deepEqual(assistant, ["the summary"]);
  assert.equal(activityCalls, 1);
  assert.ok(typesOf(id).includes("result"));
  await bridge.dispose();
});
