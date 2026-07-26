import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type {
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  query as queryFunction,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeOwnedAgent } from "../src/claude-owned-agent.js";
import type { OwnedAgentEvent, OwnedAgentSink } from "../src/owned-agent.js";

const cwd = await mkdtemp(path.join(os.tmpdir(), "even-better-claude-owned-"));
after(() => rm(cwd, { recursive: true, force: true }));

const config = {
  bin: "/fake/claude",
  env: {},
  startupTimeoutMs: 500,
  cancelTimeoutMs: 500,
  shutdownTimeoutMs: 500,
};

class MessageStream implements AsyncIterator<SDKMessage>, AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
  private waiting: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;

  push(message: SDKMessage): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.values.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this;
  }
}

class Sink implements OwnedAgentSink {
  events: OwnedAgentEvent[] = [];
  event(event: OwnedAgentEvent): void {
    this.events.push(event);
  }
  count(type: OwnedAgentEvent["type"]): number {
    return this.events.filter((event) => event.type === type).length;
  }
}

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function result(success: boolean, cancelled = false): SDKMessage {
  return sdkMessage(success ? {
    type: "result",
    subtype: "success",
    result: "Claude done.",
    stop_reason: null,
    total_cost_usd: 0.01,
    num_turns: 2,
    usage: { input_tokens: 9, output_tokens: 6 },
  } : {
    type: "result",
    subtype: "error_during_execution",
    errors: [cancelled ? "Interrupted." : "Failed."],
    stop_reason: cancelled ? "cancelled" : null,
    total_cost_usd: 0,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 0 },
  });
}

type FactoryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Parameters<typeof queryFunction>[0]["options"];
};

/**
 * Mirrors the real CLI's ordering: `system/init` is emitted only once a turn starts, never
 * eagerly at spawn. A fake that announces init up front hides the startup deadlock this
 * adapter was rewritten to avoid.
 */
function fakeQueryFactory(): {
  factory: typeof queryFunction;
  permissions: PermissionResult[];
  resumes: Array<string | undefined>;
  sessionIds: Array<string | undefined>;
  closeCount: () => number;
} {
  const permissions: PermissionResult[] = [];
  const resumes: Array<string | undefined> = [];
  const sessionIds: Array<string | undefined> = [];
  let closed = 0;
  const factory = ((params: FactoryParams) => {
    resumes.push(params.options?.resume);
    sessionIds.push(params.options?.sessionId);
    const stream = new MessageStream();
    let interrupted = false;
    let announced = false;
    void (async () => {
      if (typeof params.prompt === "string") return;
      for await (const message of params.prompt) {
        if (!announced) {
          announced = true;
          stream.push(sdkMessage({
            type: "system",
            subtype: "init",
            model: "fake-claude-model",
            session_id: params.options?.resume ?? params.options?.sessionId ?? "private-session",
            uuid: "init",
          }));
        }
        const content = message.message.content;
        const prompt = typeof content === "string" ? content : "";
        if (prompt === "hang") {
          while (!interrupted) await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        if (prompt === "parallel") {
          stream.push(sdkMessage({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "a" } },
                { type: "tool_use", id: "tool-b", name: "Read", input: { file_path: "b" } },
              ],
            },
          }));
          // The SDK dispatches a batched message's permissions concurrently — it never
          // awaits one before firing the next.
          const decisions = await Promise.all([
            params.options!.canUseTool!("Read", { file_path: "a" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-a",
              requestId: "req-a",
              title: "Claude wants to read a",
            }),
            params.options!.canUseTool!("Read", { file_path: "b" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-b",
              requestId: "req-b",
            }),
          ]);
          for (const decision of decisions) {
            // A null decision means the SDK orphaned a batched request — the
            // exact failure this test exists to catch.
            assert.ok(decision, "every batched can_use_tool must resolve a decision");
            permissions.push(decision);
          }
          stream.push(result(true));
          continue;
        }
        stream.push(sdkMessage({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I will inspect it.\n\n" },
              { type: "tool_use", id: "private-tool", name: "Bash", input: { command: "pwd" } },
              { type: "tool_use", id: "private-todo", name: "TodoWrite", input: { todos: [{ content: "Inspect", status: "in_progress" }] } },
            ],
          },
        }));
        const permission = await params.options!.canUseTool!(
          "Bash",
          { command: "pwd" },
          {
            signal: new AbortController().signal,
            toolUseID: "private-tool",
            requestId: "private-request",
            suggestions: [{
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "pwd" }],
              behavior: "allow",
              destination: "session",
            }],
          },
        );
        if (permission) permissions.push(permission);
        stream.push(sdkMessage({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "private-tool", content: "workspace" }] },
        }));
        const question = await params.options!.canUseTool!(
          "AskUserQuestion",
          {
            questions: [{
              question: "Which depth?",
              header: "Depth",
              options: [
                { label: "Quick", description: "Short" },
                { label: "Deep", description: "Full" },
              ],
              multiSelect: false,
            }],
          },
          { signal: new AbortController().signal, toolUseID: "private-question", requestId: "private-question-request" },
        );
        if (question) permissions.push(question);
        stream.push(sdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "Finished Deep." }] } }));
        stream.push(result(true));
      }
    })();
    const handle = {
      next: () => stream.next(),
      return: async () => ({ done: true, value: undefined }),
      throw: async (error: unknown) => { throw error; },
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({ models: [], commands: [], agents: [], output_style: "", available_output_styles: [], account: {} }) as SDKControlInitializeResponse,
      interrupt: async () => {
        interrupted = true;
        stream.push(result(false, true));
        return undefined;
      },
      close: () => {
        closed++;
        stream.close();
      },
    };
    return handle as unknown as Query;
  }) as typeof queryFunction;
  return { factory, permissions, resumes, sessionIds, closeCount: () => closed };
}

/** A child that writes to stderr and never completes the control handshake. */
function stallingQueryFactory(stderrText: string): typeof queryFunction {
  return ((params: FactoryParams) => {
    params.options?.stderr?.(stderrText);
    const stream = new MessageStream();
    const handle = {
      next: () => stream.next(),
      return: async () => ({ done: true, value: undefined }),
      throw: async (error: unknown) => { throw error; },
      [Symbol.asyncIterator]() { return this; },
      initializationResult: () => new Promise<SDKControlInitializeResponse>(() => {}),
      interrupt: async () => undefined,
      close: () => stream.close(),
    };
    return handle as unknown as Query;
  }) as typeof queryFunction;
}

async function waitFor(sink: Sink, type: OwnedAgentEvent["type"], count = 1): Promise<OwnedAgentEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const matches = sink.events.filter((event) => event.type === type);
    if (matches.length >= count) return matches[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(sink.events)}`);
}

test("Claude start names its own session and never waits for a turn to begin", async () => {
  const fake = fakeQueryFactory();
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, config, fake.factory);
  try {
    const started = await agent.start(sink);
    // No prompt has been sent, so system/init cannot have arrived — startup must not need it.
    assert.match(started.nativeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(fake.sessionIds, [started.nativeSessionId]);
    assert.deepEqual(fake.resumes, [undefined]);
    assert.equal(sink.events.length, 0);

    // The model is late-bound: it lands with turn one.
    await agent.prompt("inspect");
    const model = await waitFor(sink, "model");
    assert.equal(model.type === "model" && model.model, "fake-claude-model");
  } finally {
    await agent.dispose();
  }
});

test("Claude resume passes resume and never a conflicting session id", async () => {
  const fake = fakeQueryFactory();
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, config, fake.factory);
  try {
    const started = await agent.start(sink, "remembered-claude-session");
    assert.equal(started.nativeSessionId, "remembered-claude-session");
    assert.deepEqual(fake.resumes, ["remembered-claude-session"]);
    assert.deepEqual(fake.sessionIds, [undefined]);
  } finally {
    await agent.dispose();
  }
});

test("Claude SDK adapter keeps one streaming session for tools, plans, permissions, questions, and interruption", async () => {
  const fake = fakeQueryFactory();
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, config, fake.factory);
  try {
    const started = await agent.start(sink, "remembered-claude-session");
    assert.equal(started.nativeSessionId, "remembered-claude-session");
    assert.deepEqual(fake.resumes, ["remembered-claude-session"]);
    await agent.prompt("inspect");
    const permission = await waitFor(sink, "permission");
    assert.ok(permission.type === "permission" && permission.options.some((option) => option.key === "allowAlways"));
    // The real tool id, so the bridge can attach this to the tool's existing bubble.
    assert.equal(permission.type === "permission" && permission.toolId, "private-tool");
    await agent.respondPermission("allowAlways");
    await waitFor(sink, "question");
    await agent.respondQuestion("Deep");
    const completed = await waitFor(sink, "result");
    assert.equal(completed.type === "result" && completed.success, true);
    assert.ok(sink.events.some((event) => event.type === "plan"));
    assert.ok(sink.events.some((event) => event.type === "tool" && event.status === "completed" && event.output === "workspace"));
    assert.equal(fake.permissions[0]?.behavior, "allow");
    assert.ok(fake.permissions[0]?.behavior === "allow" && fake.permissions[0].updatedPermissions?.every((update) => "destination" in update && update.destination === "session"));

    await agent.prompt("hang");
    await agent.interrupt();
    const interrupted = await waitFor(sink, "result", 2);
    assert.equal(interrupted.type === "result" && interrupted.cancelled, true);
  } finally {
    await agent.dispose();
  }
  assert.equal(fake.closeCount(), 1);
});

test("Claude shows batched permissions one at a time and settles every one", async () => {
  const fake = fakeQueryFactory();
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, config, fake.factory);
  try {
    await agent.start(sink);
    await agent.prompt("parallel");

    const first = await waitFor(sink, "permission");
    assert.equal(first.type === "permission" && first.toolId, "tool-a");
    // The second request is queued, not shown — showing both would orphan the first.
    assert.equal(sink.count("permission"), 1);
    // The SDK's rendered prompt beats a raw JSON dump of the input.
    assert.equal(first.type === "permission" && first.description, "Claude wants to read a");
    await agent.respondPermission("allow");

    const second = await waitFor(sink, "permission", 2);
    assert.equal(second.type === "permission" && second.toolId, "tool-b");
    assert.equal(second.type === "permission" && second.description, '{\n  "file_path": "b"\n}');
    await agent.respondPermission("deny");

    const completed = await waitFor(sink, "result");
    assert.equal(completed.type === "result" && completed.success, true);
    assert.equal(fake.permissions.length, 2);
    assert.equal(fake.permissions[0]?.behavior, "allow");
    assert.equal(fake.permissions[1]?.behavior, "deny");
  } finally {
    await agent.dispose();
  }
});

test("Claude startup failure reports the child's stderr", async () => {
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, config, stallingQueryFactory("Invalid API key · Please run /login"));
  await assert.rejects(
    agent.start(sink),
    (error: Error) =>
      /Claude startup timed out/.test(error.message) && /Invalid API key · Please run \/login/.test(error.message),
  );
});
