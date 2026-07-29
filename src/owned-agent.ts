import type { ProviderId } from "./session.js";

/** The last three are Claude's plan-ready fork (`ExitPlanMode`): approving a plan
 *  also chooses the mode execution runs in, so the decision and the mode switch
 *  are one answer. Every decision is validated against the options the
 *  interaction actually advertised, never against this union — an adapter that
 *  does not offer a key can never receive it. */
export type OwnedPermissionDecision =
  | "allow"
  | "allowAlways"
  | "deny"
  | "planAuto"
  | "planNormal"
  | "planKeep";

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

/** The glasses' whole mode vocabulary. Provider-neutral on purpose: native mode
 *  ids (Claude's `PermissionMode`, Codex's collaboration mode × sandbox ×
 *  approval policy) never cross this seam, the way ACP ids never do. */
export type AgentMode = "plan" | "normal" | "auto";

export const AGENT_MODES: readonly AgentMode[] = ["plan", "normal", "auto"];

export type OwnedAgentEvent =
  | { type: "model"; model: string }
  | { type: "commands"; commands: OwnedCommand[] }
  /** Provider truth, not what we last asked for: emitted only once the provider
   *  reports the mode (Claude's `system/init`, Codex's `thread/settings/updated`). */
  | { type: "mode"; mode: AgentMode }
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
  /** Optional capability, like `commands()`. Resolves once the provider has
   *  confirmed the switch, and rejects when it cannot switch at runtime — the
   *  bridge reports that as "mode switching unavailable" rather than gating the
   *  provider, since an older CLI is otherwise perfectly usable. */
  setMode?(mode: AgentMode): Promise<void>;
  respondPermission(decision: string): Promise<void>;
  respondQuestion(answer: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
