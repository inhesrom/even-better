// The four consumption semantics the Even app applies to every SSE event
// (docs/PROTOCOL.md §Outbound), as a pure reducer:
//
//   append        entries[] grows and is never edited
//   keyed         one bubble per toolId, tool_start → tool_end in place
//   single-slot   status / stats / progress overwrite, never append
//   interactive   at most one open menu
//
// Split out from tools/app-tui.ts because this is the only part with behaviour
// worth testing on its own — sockets, ANSI and key handling live there.

export interface ToolBubble {
  toolId: string;
  name: string;
  summary: string;
  done: boolean;
}

export type Entry =
  | { kind: "prompt"; text: string }
  | { kind: "say"; text: string }
  | { kind: "tool"; tool: ToolBubble }
  | { kind: "result"; success: boolean; text: string; durationMs: number; inputTokens: number; outputTokens: number }
  | { kind: "notification"; title: string; message: string }
  | { kind: "ack"; text: string }
  | { kind: "raw"; text: string };

export interface Stats {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Progress {
  completed: number;
  total: number;
  current: string;
}

export interface PermissionPrompt {
  kind: "permission";
  toolName: string;
  description: string;
  options: { text: string; key: string }[];
}

export interface QuestionPrompt {
  kind: "question";
  header: string;
  question: string;
  options: { label: string; description: string }[];
}

export type Pending = PermissionPrompt | QuestionPrompt;

export interface AppState {
  entries: Entry[];
  status: string;
  stats: Stats | null;
  progress: Progress | null;
  pending: Pending | null;
}

export function initialState(): AppState {
  return { entries: [], status: "idle", stats: null, progress: null, pending: null };
}

type Wire = Record<string, unknown>;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const objects = (value: unknown): Wire[] =>
  Array.isArray(value) ? value.filter((item): item is Wire => typeof item === "object" && item !== null) : [];

function append(state: AppState, entry: Entry): AppState {
  return { ...state, entries: [...state.entries, entry] };
}

/** text_delta arrives a few code points at a time; folding it into the trailing
 *  prose entry is what makes the transcript readable, and is only sound because
 *  append events are immutable once sent (docs/PROTOCOL.md §1). A tool bubble
 *  landing between deltas ends the block, preserving arrival order. */
function appendText(state: AppState, text: string): AppState {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind !== "say") return append(state, { kind: "say", text });
  const merged: Entry = { kind: "say", text: last.text + text };
  return { ...state, entries: [...state.entries.slice(0, -1), merged] };
}

/** tool_end closes the bubble its toolId opened. An id we never saw opened is
 *  dropped rather than rendered: the app keys one bubble per id, so inventing a
 *  second bubble here would show a tool that never ran. */
function closeTool(state: AppState, toolId: string, summary: string): AppState {
  let closed = false;
  const entries = state.entries.map((entry): Entry => {
    if (closed || entry.kind !== "tool") return entry;
    if (entry.tool.toolId !== toolId || entry.tool.done) return entry;
    closed = true;
    return { ...entry, tool: { ...entry.tool, done: true, summary: summary || entry.tool.summary } };
  });
  return closed ? { ...state, entries } : state;
}

function permission(event: Wire): PermissionPrompt {
  const options = objects(event.options)
    .map((option) => ({ text: str(option.text, str(option.key)), key: str(option.key) }))
    .filter((option) => option.key !== "");
  return {
    kind: "permission",
    toolName: str(event.toolName, "tool"),
    description: str(event.description, str(event.detail)),
    // A malformed menu still has to be answerable: interaction timeouts never
    // auto-deny, so an unanswerable menu strands the turn forever (AGENTS.md).
    options: options.length ? options : [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }],
  };
}

/** One question per event — the server sequences multi-question flows itself and
 *  emits the next only after the previous is answered (src/grok-owned-agent.ts). */
function question(event: Wire): QuestionPrompt | null {
  const first = objects(event.questions)[0];
  if (!first) return null;
  return {
    kind: "question",
    header: str(first.header, "Question"),
    question: str(first.question),
    options: objects(first.options)
      .map((option) => ({ label: str(option.label), description: str(option.description) }))
      .filter((option) => option.label !== ""),
  };
}

export function reduce(state: AppState, event: unknown): AppState {
  if (typeof event !== "object" || event === null) {
    return append(state, { kind: "raw", text: String(event) });
  }
  const wire = event as Wire;
  switch (str(wire.type)) {
    // 1. Append — immutable.
    case "user_prompt":
      return append(state, { kind: "prompt", text: str(wire.text) });
    case "text_delta":
      return appendText(state, str(wire.text));
    case "result":
      return append(state, {
        kind: "result",
        success: wire.success !== false,
        text: str(wire.text),
        durationMs: num(wire.durationMs),
        inputTokens: num(wire.inputTokens),
        outputTokens: num(wire.outputTokens),
      });
    case "notification":
      return append(state, { kind: "notification", title: str(wire.title), message: str(wire.message) });

    // 2. Keyed update — one bubble per toolId.
    case "tool_start":
      return append(state, {
        kind: "tool",
        tool: {
          toolId: str(wire.toolId),
          name: str(wire.name, "tool"),
          summary: str(wire.summary),
          done: false,
        },
      });
    case "tool_end":
      return closeTool(state, str(wire.toolId), str(wire.summary));

    // 3. Single-slot widgets — overwrite, never append. `state` is taken as-is:
    // the official package also emits think_start/text_start/think_end/text_end
    // from its Codex path, which this repo never sends.
    case "status":
      return { ...state, status: str(wire.state, state.status) };
    case "running_stats":
      return {
        ...state,
        stats: {
          durationMs: num(wire.durationMs),
          inputTokens: num(wire.inputTokens),
          outputTokens: num(wire.outputTokens),
        },
      };
    case "task_progress":
      return {
        ...state,
        progress: { completed: num(wire.completed), total: num(wire.total), current: str(wire.current) },
      };

    // 4. Interactive — at most one open menu, cleared by its paired ack.
    case "permission_request":
      return { ...state, pending: permission(wire) };
    case "user_question": {
      const prompt = question(wire);
      return prompt ? { ...state, pending: prompt } : state;
    }
    case "permission_result":
      return append({ ...state, pending: null }, {
        kind: "ack",
        text: `permission ${str(wire.decision, "?")} · ${str(wire.toolName, "tool")}`,
      });
    case "question_answer": {
      const answers = typeof wire.answers === "object" && wire.answers !== null ? (wire.answers as Wire) : {};
      return append({ ...state, pending: null }, { kind: "ack", text: `answered · ${str(answers.answer, "?")}` });
    }

    default:
      // Unknown types must not be fatal — the official package emits `error`,
      // which this repo never sends (docs/PROTOCOL.md §Transport).
      return append(state, { kind: "raw", text: JSON.stringify(wire) });
  }
}
