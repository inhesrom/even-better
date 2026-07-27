import type { ProviderId } from "./session.js";

export type OwnedPermissionDecision = "allow" | "allowAlways" | "deny";

export interface OwnedQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface OwnedQuestion {
  question: string;
  header: string;
  options: OwnedQuestionOption[];
  multiSelect?: boolean;
}

export interface OwnedUsage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** One provider-native slash command. `name` never carries the leading slash, so
 *  matching and display do not have to agree on whether it is there. */
export interface OwnedCommand {
  name: string;
  description: string;
  /** Present when the command takes arguments — the glasses ask for them. */
  argumentHint?: string;
  aliases?: string[];
}

export type OwnedAgentEvent =
  | { type: "model"; model: string }
  | { type: "commands"; commands: OwnedCommand[] }
  | { type: "prose"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "pending" | "running" | "completed" | "failed";
      input?: unknown;
      output?: string;
    }
  | { type: "plan"; entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { type: "usage"; usage: OwnedUsage }
  | {
      type: "permission";
      id: string;
      toolId: string;
      toolName: string;
      description: string;
      options: Array<{ key: OwnedPermissionDecision; label: string }>;
    }
  | { type: "question"; id: string; question: OwnedQuestion; index: number; total: number }
  | {
      type: "result";
      success: boolean;
      text?: string;
      cancelled?: boolean;
      costUsd?: number;
      usage?: OwnedUsage;
    }
  | { type: "notification"; title: string; message: string }
  | { type: "fatal"; message: string };

export interface OwnedAgentSink {
  event(event: OwnedAgentEvent): void;
}

export interface OwnedAgentStartInfo {
  nativeSessionId: string;
  model: string;
}

/** One process-owned coding agent. Provider-private IDs never cross this seam. */
export interface OwnedAgent {
  readonly provider: ProviderId;
  readonly cwd: string;
  start(sink: OwnedAgentSink, nativeSessionId?: string): Promise<OwnedAgentStartInfo>;
  prompt(text: string): Promise<void>;
  /** Optional capability, like `Multiplexer.explain()`: providers with no command
   *  surface (Codex's app-server) simply do not implement it. Executing a command
   *  stays `prompt("/name args")` — only enumeration needs a seam. */
  commands?(): OwnedCommand[];
  respondPermission(decision: string): Promise<void>;
  respondQuestion(answer: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
