import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMode, OwnedAgent, OwnedAgentSink, OwnedAgentStartInfo } from "../src/owned-agent.js";
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

/** A stub that advertises commands, so the bridge's dispatch path is reachable. */
class CommandAgent extends StubAgent {
  private readonly list = [
    { name: "usage", description: "Show usage" },
    { name: "compact", description: "Compact the context" },
    { name: "grill", description: "Grill" },
    { name: "grill-me", description: "Grill me" },
    { name: "research", description: "Research", argumentHint: "<topic>" },
  ];

  commands(): typeof this.list {
    return this.list;
  }
}

/** Start a bridge with its command list already advertised, and always dispose it:
 *  a bridge left mid-turn keeps its 10s stats interval alive and the runner never exits. */
async function commandBridge(
  id: string,
  run: (bridge: InstanceType<typeof OwnedSessionBridge>, agent: CommandAgent) => Promise<void>,
): Promise<void> {
  const agent = new CommandAgent();
  const bridge = new OwnedSessionBridge(id, agent);
  await bridge.start();
  agent.sink!.event({ type: "commands", commands: agent.commands() });
  try {
    await run(bridge, agent);
  } finally {
    await bridge.dispose();
  }
}

const lastQuestion = (id: string): { question: string; options: { label: string }[] } => {
  const wire = getMessages(id, 0).filter((message) => (message as { type?: string }).type === "user_question").pop();
  return (wire as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0];
};

test("an unambiguous command dispatches straight through as its slash form", async () => {
  await commandBridge("owned:cmd-direct", async (bridge, agent) => {
    await bridge.prompt("slash usage");
    // No menu: the spoken form resolved to exactly one command that needs nothing else.
    assert.deepEqual(agent.prompts, ["/usage"]);
    assert.equal(typesOf("owned:cmd-direct").includes("user_question"), false);
    assert.equal(bridge.state, "busy");
  });
});

test("prose is untouched, and so is every prompt to a provider with no commands", async () => {
  await commandBridge("owned:cmd-prose", async (bridge, agent) => {
    await bridge.prompt("compact the summary please");
    assert.deepEqual(agent.prompts, ["compact the summary please"]);
  });

  // Codex advertises nothing, so its sessions behave exactly as they did before.
  const bare = new StubAgent();
  const codex = new OwnedSessionBridge("owned:cmd-none", bare);
  await codex.start();
  await codex.prompt("/compact");
  assert.deepEqual(bare.prompts, ["/compact"]);
  await codex.dispose();
});

test("an ambiguous phrase asks which command, then runs the pick", async () => {
  const id = "owned:cmd-pick";
  await commandBridge(id, async (bridge, agent) => {
    await bridge.prompt("slash gril");
    await waitFor("the picker", () => typesOf(id).includes("user_question"));
    assert.equal(bridge.state, "awaiting");
    assert.deepEqual(lastQuestion(id).options.map((option) => option.label), ["/grill", "/grill-me", "Cancel"]);
    assert.deepEqual(agent.prompts, []);

    await bridge.respondQuestion("/grill-me");
    assert.deepEqual(agent.prompts, ["/grill-me"]);
    assert.equal(bridge.state, "busy");
  });
});

test("a command that takes arguments asks for them, and free text is accepted", async () => {
  const id = "owned:cmd-args";
  await commandBridge(id, async (bridge, agent) => {
    await bridge.prompt("slash research");
    await waitFor("the argument question", () => typesOf(id).includes("user_question"));
    assert.match(lastQuestion(id).question, /<topic>/);
    // The phone can answer with something no option offered — the directory step
    // relies on exactly the same behaviour.
    await bridge.respondQuestion("the auth flow");
    assert.deepEqual(agent.prompts, ["/research the auth flow"]);
  });

  // Arguments supplied up front skip the question entirely.
  await commandBridge("owned:cmd-args-inline", async (bridge, agent) => {
    await bridge.prompt("slash research auth flow");
    assert.deepEqual(agent.prompts, ["/research auth flow"]);
  });
});

test("a destructive command is confirmed before it runs", async () => {
  const id = "owned:cmd-confirm";
  await commandBridge(id, async (bridge, agent) => {
    await bridge.prompt("/compact");
    await waitFor("the confirmation", () => typesOf(id).includes("user_question"));
    assert.match(lastQuestion(id).question, /cannot be undone/);
    assert.deepEqual(agent.prompts, []);

    await bridge.respondQuestion("Run /compact");
    assert.deepEqual(agent.prompts, ["/compact"]);
  });
});

// A command question opens inside the turn `prompt()` started. Abandoning it must still
// terminalize: `terminalizing`/`state` gate prompt() with a 409 and make interrupt() a
// no-op, so a turn that never ends wedges the session for the life of the process.
test("cancelling a command question ends the turn and leaves the session usable", async () => {
  const id = "owned:cmd-cancel";
  await commandBridge(id, async (bridge, agent) => {
    await bridge.prompt("slash gril");
    await waitFor("the picker", () => typesOf(id).includes("user_question"));

    await bridge.respondQuestion("Cancel");
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.prompts, []);
    assert.ok(typesOf(id).includes("result"));

    // The session still takes work — this is the whole point of the invariant.
    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });
});

test("an unadvertised slash command still reaches the provider", async () => {
  await commandBridge("owned:cmd-unknown", async (bridge, agent) => {
    // Nothing is close enough to offer, so the provider reports its own unknown
    // command rather than even-better inventing an error for it.
    await bridge.prompt("slash zzzzz");
    assert.deepEqual(agent.prompts, ["/zzzzz"]);
  });
});

// A command question has no provider turn behind it, so agent.interrupt() finds nothing
// active and returns a no-op. Without special handling the bridge stays busy forever —
// and this is the only escape if a menu ever fails to render on the glasses.
test("interrupting a command question releases the session", async () => {
  const id = "owned:cmd-interrupt";
  await commandBridge(id, async (bridge, agent) => {
    await bridge.prompt("slash gril");
    await waitFor("the picker", () => typesOf(id).includes("user_question"));

    await bridge.interrupt();
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.prompts, []);

    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });
});

/** A stub that can switch modes, and reports provider truth the way a real adapter
 *  does — the bridge must never mark the picker from what it merely requested. */
class ModeAgent extends StubAgent {
  applied: AgentMode[] = [];
  failWith: string | null = null;

  setMode(mode: AgentMode): Promise<void> {
    if (this.failWith) return Promise.reject(new Error(this.failWith));
    this.applied.push(mode);
    this.sink?.event({ type: "mode", mode });
    return Promise.resolve();
  }
}

async function modeBridge(
  id: string,
  run: (bridge: InstanceType<typeof OwnedSessionBridge>, agent: ModeAgent, modes: AgentMode[]) => Promise<void>,
): Promise<void> {
  const agent = new ModeAgent();
  const modes: AgentMode[] = [];
  const bridge = new OwnedSessionBridge(id, agent, { mode: (mode) => modes.push(mode) });
  await bridge.start();
  try {
    await run(bridge, agent, modes);
  } finally {
    await bridge.dispose();
  }
}

test("a spoken mode switch applies it, says so, and ends the turn", async () => {
  const id = "owned:mode-switch";
  await modeBridge(id, async (bridge, agent, modes) => {
    await bridge.prompt("change to auto mode");
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.applied, ["auto"]);
    // Never sent to the provider as text: this is a capability call, not a prompt.
    assert.deepEqual(agent.prompts, []);
    assert.deepEqual(modes, ["auto"], "the confirmed mode was not persisted");
    assert.ok(typesOf(id).includes("notification"));
    assert.ok(typesOf(id).includes("result"));

    // The session still takes ordinary work afterwards.
    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });
});

test("a bare mode request opens a four-option picker marked with the current mode", async () => {
  const id = "owned:mode-menu";
  await modeBridge(id, async (bridge, agent) => {
    await bridge.prompt("mode");
    await waitFor("the picker", () => typesOf(id).includes("user_question"));
    assert.equal(bridge.state, "awaiting");
    const options = lastQuestion(id).options.map((option) => option.label);
    // Four is the largest menu the glasses are known to render; eleven silently did not.
    assert.deepEqual(options, ["Plan", "Normal · current", "Auto", "Cancel"]);
    assert.deepEqual(agent.applied, []);

    await bridge.respondQuestion("Plan");
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.applied, ["plan"]);

    // The mark follows provider truth, so the next picker shows the new mode.
    await bridge.prompt("mode");
    await waitFor("the second picker", () => bridge.state === "awaiting");
    assert.deepEqual(lastQuestion(id).options.map((option) => option.label), [
      "Plan · current",
      "Normal",
      "Auto",
      "Cancel",
    ]);
    await bridge.respondQuestion("Cancel");
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.applied, ["plan"], "cancelling must not switch anything");
  });
});

// The mode question rides the same turn machinery as a command question, so the same
// invariant applies: every exit terminalizes or the session is wedged for good.
test("cancelling or interrupting the mode picker leaves the session usable", async () => {
  await modeBridge("owned:mode-cancel", async (bridge, agent) => {
    await bridge.prompt("mode");
    await waitFor("the picker", () => bridge.state === "awaiting");
    await bridge.respondQuestion("Cancel");
    await waitFor("the turn to close", () => bridge.state === "idle");
    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });

  await modeBridge("owned:mode-interrupt", async (bridge, agent) => {
    await bridge.prompt("mode");
    await waitFor("the picker", () => bridge.state === "awaiting");
    await bridge.interrupt();
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.applied, []);
    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });
});

test("a provider that cannot switch reports it and still ends the turn", async () => {
  const id = "owned:mode-unavailable";
  await modeBridge(id, async (bridge, agent, modes) => {
    agent.failWith = "Unknown method thread/settings/update";
    await bridge.prompt("switch to plan mode");
    await waitFor("the turn to close", () => bridge.state === "idle");
    assert.deepEqual(agent.applied, []);
    assert.deepEqual(modes, [], "a failed switch must not be persisted");
    assert.ok(typesOf(id).includes("notification"));
    await bridge.prompt("carry on");
    assert.deepEqual(agent.prompts, ["carry on"]);
  });
});

// Grok today, and any provider whose CLI cannot switch: the text is an ordinary
// prompt and must reach the agent byte-identical.
test("a provider without the capability passes mode phrasing straight through", async () => {
  const agent = new StubAgent();
  const bridge = new OwnedSessionBridge("owned:mode-nocap", agent);
  await bridge.start();
  await bridge.prompt("change to auto mode");
  assert.deepEqual(agent.prompts, ["change to auto mode"]);
  await bridge.dispose();
});

test("a remembered mode is reapplied when the session attaches", async () => {
  const agent = new ModeAgent();
  const bridge = new OwnedSessionBridge("owned:mode-restore", agent);
  await bridge.start("native-stub", "plan");
  assert.deepEqual(agent.applied, ["plan"]);
  await bridge.dispose();

  // Normal is what every provider already starts in, so restoring it is a no-op
  // rather than an extra control round trip on every attach.
  const fresh = new ModeAgent();
  const plain = new OwnedSessionBridge("owned:mode-restore-normal", fresh);
  await plain.start("native-stub", "normal");
  assert.deepEqual(fresh.applied, []);
  await plain.dispose();
});

// Failing to restore a mode must not fail the attach: the row would be stranded with
// no session at all, which is strictly worse than a session in the wrong mode.
test("a session whose mode cannot be restored still opens", async () => {
  const agent = new ModeAgent();
  agent.failWith = "Claude did not acknowledge the mode change.";
  const id = "owned:mode-restore-fail";
  const bridge = new OwnedSessionBridge(id, agent);
  const info = await bridge.start("native-stub", "plan");
  assert.equal(info.nativeSessionId, "native-stub");
  await bridge.prompt("carry on");
  assert.deepEqual(agent.prompts, ["carry on"]);
  await bridge.dispose();
});
