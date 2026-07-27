#!/usr/bin/env node

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.142.5"}\n`);
  process.exit(0);
}

let buffer = "";
let turn = 0;
let activeTurn = "";
let approvalId = 900;
let questionId = 901;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ id, result });
}

function notify(method, params) {
  send({ method, params });
}

function permissionFlow() {
  notify("item/started", {
    threadId: "fake-thread",
    turnId: activeTurn,
    startedAtMs: Date.now(),
    item: {
      type: "commandExecution",
      id: "private-command",
      command: "printf hello",
      cwd: process.cwd(),
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
    },
  });
  send({
    id: approvalId,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "fake-thread",
      turnId: activeTurn,
      itemId: "private-command",
      startedAtMs: Date.now(),
      reason: "Run the test command",
      command: "printf hello",
      cwd: process.cwd(),
    },
  });
}

function afterApproval(result) {
  notify("item/commandExecution/outputDelta", {
    threadId: "fake-thread",
    turnId: activeTurn,
    itemId: "private-command",
    delta: result?.decision === "decline" ? "denied" : "hello",
  });
  notify("item/completed", {
    threadId: "fake-thread",
    turnId: activeTurn,
    completedAtMs: Date.now(),
    item: {
      type: "commandExecution",
      id: "private-command",
      command: "printf hello",
      cwd: process.cwd(),
      status: result?.decision === "decline" ? "declined" : "completed",
      commandActions: [],
      aggregatedOutput: result?.decision === "decline" ? "denied" : "hello",
    },
  });
  send({
    id: questionId,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "fake-thread",
      turnId: activeTurn,
      itemId: "private-question",
      autoResolutionMs: null,
      questions: [
        {
          id: "depth",
          header: "Depth",
          question: "Which depth?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Quick", description: "Short pass" },
            { label: "Deep", description: "Full pass" },
          ],
        },
      ],
    },
  });
}

function afterQuestion(result) {
  const answer = result?.answers?.depth?.answers?.[0] ?? "unknown";
  notify("item/agentMessage/delta", {
    threadId: "fake-thread",
    turnId: activeTurn,
    itemId: "message-1",
    delta: `Finished ${answer}.`,
  });
  notify("turn/plan/updated", {
    threadId: "fake-thread",
    turnId: activeTurn,
    explanation: null,
    plan: [{ step: "Inspect", status: "completed" }],
  });
  notify("thread/tokenUsage/updated", {
    threadId: "fake-thread",
    turnId: activeTurn,
    tokenUsage: {
      total: { inputTokens: 13, outputTokens: 8, totalTokens: 21, cachedInputTokens: 0, reasoningOutputTokens: 0 },
      last: { inputTokens: 13, outputTokens: 8, totalTokens: 21, cachedInputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    },
  });
  notify("turn/completed", {
    threadId: "fake-thread",
    turn: { id: activeTurn, items: [], itemsView: "full", status: "completed", error: null },
  });
}

function handle(message) {
  if (Object.hasOwn(message, "result")) {
    if (message.id === approvalId) afterApproval(message.result);
    else if (message.id === questionId) afterQuestion(message.result);
    return;
  }
  if (message.method === "initialize") {
    response(message.id, { userAgent: "fake", platformFamily: "unix", platformOs: "linux" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    response(message.id, {
      thread: { id: "fake-thread", status: { type: "idle" } },
      model: "fake-codex-model",
      modelProvider: "openai",
      cwd: process.cwd(),
    });
    return;
  }
  if (message.method === "thread/resume") {
    response(message.id, {
      thread: { id: message.params?.threadId ?? "fake-thread", turns: [], status: { type: "idle" } },
      model: "fake-codex-model",
      modelProvider: "openai",
      cwd: process.cwd(),
    });
    return;
  }
  if (message.method === "turn/start") {
    activeTurn = `turn-${++turn}`;
    response(message.id, { turn: { id: activeTurn, items: [], itemsView: "full", status: "inProgress", error: null } });
    notify("turn/started", { threadId: "fake-thread", turn: { id: activeTurn, items: [], itemsView: "full", status: "inProgress", error: null } });
    const prompt = message.params?.input?.[0]?.text ?? "";
    if (prompt.includes("hang")) {
      notify("item/started", {
        threadId: "fake-thread",
        turnId: activeTurn,
        startedAtMs: Date.now(),
        item: { type: "commandExecution", id: "private-hang", command: "sleep", cwd: process.cwd(), status: "inProgress", commandActions: [], aggregatedOutput: null },
      });
    } else {
      permissionFlow();
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    response(message.id, {});
    notify("item/completed", {
      threadId: "fake-thread",
      turnId: activeTurn,
      completedAtMs: Date.now(),
      item: { type: "commandExecution", id: "private-hang", command: "sleep", cwd: process.cwd(), status: "failed", commandActions: [], aggregatedOutput: "cancelled" },
    });
    notify("turn/completed", {
      threadId: "fake-thread",
      turn: { id: activeTurn, items: [], itemsView: "full", status: "interrupted", error: null },
    });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
