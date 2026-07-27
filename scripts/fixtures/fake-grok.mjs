#!/usr/bin/env node

if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.103 (fake) [stable]\n");
  process.exit(0);
}

const scenario = process.env.FAKE_GROK_SCENARIO ?? "happy";
let sessionId = "fake-session";
let nextId = 1000;
let turn = 0;
let cancelled = false;
let cancelPrompt;
const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32000, message } });
}

function notify(method, params) {
  send({ method, params });
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function update(value, meta) {
  notify("session/update", { sessionId, update: value, ...(meta ? { _meta: meta } : {}) });
}

/** The command list a real ACP agent advertises, so `pnpm sim --fake` can drive the
 *  whole picker: two names sharing a prefix, one taking arguments, one destructive. */
function advertiseCommands() {
  update({
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "usage", description: "Show token usage for this session" },
      { name: "compact", description: "Compact the conversation" },
      { name: "grill", description: "Grill the current plan" },
      { name: "grill-me", description: "Grill me about a decision" },
      { name: "research", description: "Research a topic", input: { hint: "<topic>" } },
    ],
  });
}

async function happyPrompt(id) {
  turn++;
  const promptId = `prompt-${turn}`;
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I’ll inspect the workspace.\n\n" },
  });
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Read README",
    kind: "read",
    status: "pending",
    rawInput: { path: "README.md" },
  });
  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "tool-1",
      title: "Read README",
      kind: "read",
      status: "pending",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
    ],
  });
  if (cancelled || permission?.outcome?.outcome === "cancelled") {
    respond(id, { stopReason: "cancelled", _meta: { cancellationCategory: "MidTurnAbort" } });
    return;
  }
  if (permission?.outcome?.optionId === "reject-once") {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "failed",
      rawOutput: "Permission denied",
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Permission denied; no workspace data was read." },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "README contents" } }],
    rawOutput: "preferred raw output",
  });
  const questions = scenario === "questions"
    ? [
        {
          question: "Which depth should I use?",
          options: [
            { label: "Quick", description: "A concise pass" },
            { label: "Deep", description: "A detailed pass", preview: "More analysis" },
          ],
          multiSelect: false,
        },
        {
          question: "Which modes?",
          options: [
            { label: "Quick", description: "Fast" },
            { label: "Deep", description: "Careful" },
          ],
          multiSelect: true,
        },
        {
          question: "Any notes?",
          options: [{ label: "None", description: "No notes" }],
          multiSelect: false,
        },
      ]
    : [
        {
          question: "Which depth should I use?",
          options: [
            { label: "Quick", description: "A concise pass" },
            { label: "Deep", description: "A detailed pass", preview: "More analysis" },
          ],
          multiSelect: false,
        },
      ];
  const question = await request("_x.ai/ask_user_question", {
    sessionId,
    toolCallId: "question-1",
    mode: "default",
    questions,
  });
  if (cancelled || question?.outcome === "cancelled") {
    respond(id, { stopReason: "cancelled", _meta: { cancellationCategory: "MidTurnAbort" } });
    return;
  }
  if (scenario === "questions") {
    const valid = JSON.stringify(question.answers["Which depth should I use?"]) === JSON.stringify(["Deep"])
      && JSON.stringify(question.answers["Which modes?"]) === JSON.stringify(["Quick", "Deep"])
      && JSON.stringify(question.answers["Any notes?"]) === JSON.stringify(["Other"])
      && question.annotations["Which depth should I use?"].preview === "More analysis"
      && question.annotations["Any notes?"].notes === "custom detail";
    if (!valid) {
      respond(id, { stopReason: "refusal" });
      return;
    }
  }
  const selected = Object.values(question.answers).flat().join(", ");
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Finished the ${selected} pass.` },
  });
  notify("_x.ai/session_notification", {
    sessionId,
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: "end_turn",
      usage: { inputTokens: 11 * turn, outputTokens: 7 * turn, numTurns: turn },
    },
  });
  respond(id, { stopReason: "end_turn", _meta: { promptId } });
}

async function hangingPrompt(id) {
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tool-cancel",
    title: "Long task",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "wait" },
  });
  await new Promise((resolve) => {
    cancelPrompt = resolve;
  });
  respond(id, { stopReason: "cancelled", _meta: { cancellationCategory: "MidTurnAbort" } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const authMethods = scenario === "missing-auth"
      ? [{ id: "grok.com", name: "Browser login" }]
      : [{ id: "cached_token", name: "Cached login" }];
    respond(id, {
      protocolVersion: scenario === "protocol-v2" ? 2 : 1,
      agentCapabilities: process.env.FAKE_GROK_RESUME_MODE === "resume"
        ? { loadSession: false, sessionCapabilities: { resume: {} } }
        : { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods,
      agentInfo: { name: "fake-grok", version: "0.2.103" },
      _meta: { models: { currentModelId: "fake-grok-model" } },
    });
    return;
  }
  if (method === "authenticate") {
    if (scenario === "auth-error") fail(id, "not authenticated");
    else respond(id, {});
    return;
  }
  if (method === "session/new") {
    respond(id, { sessionId, _meta: { models: { currentModelId: "fake-grok-model" } } });
    // ACP agents advertise commands as a session notification after creation, not in
    // the session/new response — NewSessionResponse has no field for them.
    advertiseCommands();
    return;
  }
  if (method === "session/load" || method === "session/resume") {
    sessionId = params?.sessionId ?? sessionId;
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "historical native replay" },
    });
    respond(id, { _meta: { models: { currentModelId: "fake-grok-model" } } });
    // After the load, not during it: the bridge suppresses session updates while a
    // resume is in flight, so a list sent inside that window would be dropped.
    advertiseCommands();
    return;
  }
  if (method === "session/prompt") {
    if (scenario === "crash") {
      process.stderr.write("fake Grok crash\n");
      process.exit(17);
    }
    if (scenario === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    if (scenario === "prompt-error") {
      fail(id, "fake prompt failure with private details");
      return;
    }
    if (scenario === "wrong-session") {
      notify("session/update", {
        sessionId: "wrong-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } },
      });
      return;
    }
    if (scenario === "duplicate") {
      const value = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Only once." },
      };
      update(value, { eventId: "duplicate-event" });
      update(value, { eventId: "duplicate-event" });
      respond(id, { stopReason: "end_turn" });
      return;
    }
    const promptText = params?.prompt?.[0]?.text ?? "";
    void (scenario === "hang" || (scenario === "mixed" && promptText.includes("[hang]"))
      ? hangingPrompt(id)
      : happyPrompt(id));
    return;
  }
  fail(id, `unsupported method: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
      continue;
    }
    if (message.method === "session/cancel") {
      cancelled = true;
      cancelPrompt?.();
      continue;
    }
    if (Object.hasOwn(message, "id")) void handleRequest(message);
  }
});
