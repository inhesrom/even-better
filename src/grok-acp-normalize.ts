import type {
  ContentBlock,
  PlanEntry,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

export type JsonRecord = Record<string, unknown>;
export type GrokStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface NormalizedPromptResponse {
  stopReason: GrokStopReason;
}

export interface NormalizedToolPatch {
  id: string;
  initial: boolean;
  present: Array<"title" | "kind" | "status" | "content" | "rawInput" | "rawOutput">;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type NormalizedUpdate =
  | { kind: "user"; text: string }
  | { kind: "prose"; text: string }
  | { kind: "thought" }
  | { kind: "unsupported_content"; contentType: string; bytes: number }
  | { kind: "tool"; patch: NormalizedToolPatch }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "usage_context"; used: number; size: number }
  | { kind: "commands"; commands: NormalizedCommand[] }
  | { kind: "metadata"; updateType: string };

export interface NormalizedCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface NormalizedQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface NormalizedQuestion {
  question: string;
  options: NormalizedQuestionOption[];
  multiSelect: boolean;
}

export interface NormalizedQuestionRequest {
  sessionId: string;
  toolCallId: string;
  mode: "default" | "plan";
  questions: NormalizedQuestion[];
}

export interface TerminalUsage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  /** ACP PromptResponse.usage is per turn; Grok's terminal extension is cumulative. */
  cumulative?: false;
}

export interface XaiTurnCompleted {
  promptId: string;
  stopReason?: string;
  cancellationCategory?: string;
  usage?: TerminalUsage;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approximateBytes(content: ContentBlock): number {
  if (content.type === "image" || content.type === "audio") return content.data.length;
  if (content.type === "resource_link") return content.uri.length;
  if (content.type === "resource") {
    return "text" in content.resource ? content.resource.text.length : content.resource.blob.length;
  }
  return content.text.length;
}

function contentChunk(content: ContentBlock, user: boolean): NormalizedUpdate {
  if (content.type === "text") return { kind: user ? "user" : "prose", text: content.text };
  return {
    kind: "unsupported_content",
    contentType: content.type,
    bytes: approximateBytes(content),
  };
}

function lineCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function toolContentItem(item: ToolCallContent): string {
  if (item.type === "diff") {
    return `${item.path} (+${lineCount(item.newText)} -${lineCount(item.oldText)})`;
  }
  if (item.type === "terminal") return "[terminal output unavailable]";
  const content = item.content;
  if (content.type === "text") return content.text;
  return `[${content.type} content unavailable]`;
}

export function readableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizedTool(update: SessionUpdate): NormalizedUpdate {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    throw new Error("Expected a tool update");
  }
  const initial = update.sessionUpdate === "tool_call";
  const present: NormalizedToolPatch["present"] = [];
  const patch: NormalizedToolPatch = { id: update.toolCallId, initial, present };
  const fields = update as unknown as JsonRecord;
  if (initial || Object.hasOwn(fields, "title")) {
    present.push("title");
    patch.title = typeof update.title === "string" ? update.title : update.title === null ? null : null;
  }
  if (initial || Object.hasOwn(fields, "kind")) {
    present.push("kind");
    patch.kind = typeof update.kind === "string" ? update.kind : update.kind === null ? null : null;
  }
  if (initial || Object.hasOwn(fields, "status")) {
    present.push("status");
    patch.status = typeof update.status === "string" ? update.status : update.status === null ? null : null;
  }
  if (initial || Object.hasOwn(fields, "content")) {
    present.push("content");
    patch.content = Array.isArray(update.content)
      ? update.content.map(toolContentItem).filter(Boolean).join("\n")
      : update.content === null
        ? null
        : "";
  }
  if (initial || Object.hasOwn(fields, "rawInput")) {
    present.push("rawInput");
    patch.rawInput = update.rawInput;
  }
  if (initial || Object.hasOwn(fields, "rawOutput")) {
    present.push("rawOutput");
    patch.rawOutput = update.rawOutput;
  }
  return { kind: "tool", patch };
}

export function normalizeSessionNotification(notification: SessionNotification): NormalizedUpdate {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return contentChunk(update.content, true);
    case "agent_message_chunk":
      return contentChunk(update.content, false);
    case "agent_thought_chunk":
      return { kind: "thought" };
    case "tool_call":
    case "tool_call_update":
      return normalizedTool(update);
    case "plan":
      return { kind: "plan", entries: update.entries };
    case "usage_update":
      return { kind: "usage_context", used: update.used, size: update.size };
    case "available_commands_update":
      return {
        kind: "commands",
        commands: update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          // ACP models arguments as an unstructured input hint; everything after the
          // command name is passed through verbatim, exactly like Claude's argumentHint.
          ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
        })),
      };
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "plan_update":
    case "plan_removed":
      return { kind: "metadata", updateType: update.sessionUpdate };
    default: {
      const neverUpdate: never = update;
      throw new Error(`Unsupported ACP update: ${String(neverUpdate)}`);
    }
  }
}

function stringField(record: JsonRecord, name: string): string | null {
  return typeof record[name] === "string" ? record[name] : null;
}

export function parseQuestionRequest(raw: unknown): NormalizedQuestionRequest | null {
  if (!isRecord(raw)) return null;
  let params = raw;
  if (typeof raw.method === "string" && isRecord(raw.params)) params = raw.params;
  const sessionId = stringField(params, "sessionId");
  const toolCallId = stringField(params, "toolCallId");
  const mode = params.mode === "plan" ? "plan" : params.mode === "default" ? "default" : null;
  if (!sessionId || !toolCallId || !mode || !Array.isArray(params.questions) || !params.questions.length) {
    return null;
  }
  const questions: NormalizedQuestion[] = [];
  const seen = new Set<string>();
  for (const value of params.questions) {
    if (!isRecord(value) || typeof value.question !== "string" || seen.has(value.question)) return null;
    if (!Array.isArray(value.options) || value.options.length === 0) return null;
    const options: NormalizedQuestionOption[] = [];
    const optionLabels = new Set<string>();
    for (const option of value.options) {
      if (
        !isRecord(option)
        || typeof option.label !== "string"
        || optionLabels.has(option.label.toLowerCase())
      ) return null;
      optionLabels.add(option.label.toLowerCase());
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
        ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
      });
    }
    seen.add(value.question);
    questions.push({ question: value.question, options, multiSelect: value.multiSelect === true });
  }
  return { sessionId, toolCallId, mode, questions };
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageFromRecord(value: unknown): TerminalUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonnegative(value.inputTokens);
  const outputTokens = nonnegative(value.outputTokens);
  if (inputTokens === null || outputTokens === null) return undefined;
  return {
    inputTokens,
    outputTokens,
    turns: nonnegative(value.numTurns) ?? 1,
  };
}

export function parseXaiTurnCompleted(raw: unknown): XaiTurnCompleted | null {
  if (!isRecord(raw)) return null;
  const update = isRecord(raw.update) ? raw.update : null;
  if (!update || update.sessionUpdate !== "turn_completed") return null;
  const promptId = stringField(update, "prompt_id") ?? stringField(update, "promptId");
  if (!promptId) return null;
  return {
    promptId,
    ...(typeof update.stop_reason === "string" ? { stopReason: update.stop_reason } : {}),
    ...(typeof update.cancellationCategory === "string"
      ? { cancellationCategory: update.cancellationCategory }
      : {}),
    ...(usageFromRecord(update.usage) ? { usage: usageFromRecord(update.usage) } : {}),
  };
}

export function promptMeta(
  response: {
    stopReason: GrokStopReason;
    usage?: { inputTokens: number; outputTokens: number } | null;
    _meta?: JsonRecord | null;
  },
): { promptId?: string; usage?: TerminalUsage; cancellationCategory?: string } {
  const meta = response._meta;
  const cumulative = isRecord(meta) ? usageFromRecord(meta.usage) : undefined;
  const directInput = isRecord(meta) ? nonnegative(meta.inputTokens) : null;
  const directOutput = isRecord(meta) ? nonnegative(meta.outputTokens) : null;
  const direct =
    directInput !== null && directOutput !== null
      ? { inputTokens: directInput, outputTokens: directOutput, turns: 1 }
      : undefined;
  const standard = response.usage
    ? {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        turns: 1,
        cumulative: false as const,
      }
    : undefined;
  return {
    ...(isRecord(meta) && typeof meta.promptId === "string" ? { promptId: meta.promptId } : {}),
    ...(cumulative || direct || standard ? { usage: cumulative ?? direct ?? standard } : {}),
    ...(isRecord(meta) && typeof meta.cancellationCategory === "string"
      ? { cancellationCategory: meta.cancellationCategory }
      : {}),
  };
}

export function terminalSummary(
  stopReason: GrokStopReason,
  cancellationCategory: string | undefined,
): { success: boolean; fallback: string } {
  switch (stopReason) {
    case "end_turn":
      return { success: true, fallback: "Completed." };
    case "max_tokens":
      return { success: false, fallback: "Grok reached its token limit." };
    case "max_turn_requests":
      return { success: false, fallback: "Grok reached its turn limit." };
    case "refusal":
      return { success: false, fallback: "Grok refused the request." };
    case "cancelled":
      return {
        success: false,
        fallback:
          cancellationCategory === "PermissionRejected"
            ? "Permission denied."
            : cancellationCategory === "PermissionCancelled"
              ? "Permission cancelled."
              : "Interrupted.",
      };
  }
}
