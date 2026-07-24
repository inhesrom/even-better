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

function fakeQueryFactory(): {
  factory: typeof queryFunction;
  permissions: PermissionResult[];
  resumes: Array<string | undefined>;
  closeCount: () => number;
} {
  const permissions: PermissionResult[] = [];
  const resumes: Array<string | undefined> = [];
  let closed = 0;
  const factory = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Parameters<typeof queryFunction>[0]["options"] }) => {
    resumes.push(params.options?.resume);
    const stream = new MessageStream();
    let interrupted = false;
    stream.push(sdkMessage({
      type: "system",
      subtype: "init",
      model: "fake-claude-model",
      session_id: params.options?.resume ?? "private-session",
      uuid: "init",
    }));
    void (async () => {
      if (typeof params.prompt === "string") return;
      for await (const message of params.prompt) {
        const content = message.message.content;
        const prompt = typeof content === "string" ? content : "";
        if (prompt === "hang") {
          while (!interrupted) await new Promise((resolve) => setTimeout(resolve, 5));
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
  return { factory, permissions, resumes, closeCount: () => closed };
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

test("Claude SDK adapter keeps one streaming session for tools, plans, permissions, questions, and interruption", async () => {
  const fake = fakeQueryFactory();
  const sink = new Sink();
  const agent = new ClaudeOwnedAgent(cwd, {
    bin: "/fake/claude",
    env: {},
    startupTimeoutMs: 500,
    cancelTimeoutMs: 500,
    shutdownTimeoutMs: 500,
  }, fake.factory);
  try {
    const started = await agent.start(sink, "remembered-claude-session");
    assert.equal(started.nativeSessionId, "remembered-claude-session");
    assert.deepEqual(fake.resumes, ["remembered-claude-session"]);
    await agent.prompt("inspect");
    const permission = await waitFor(sink, "permission");
    assert.ok(permission.type === "permission" && permission.options.some((option) => option.key === "allowAlways"));
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
