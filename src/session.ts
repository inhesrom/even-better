export type ProviderId = "claude" | "codex" | "grok";
export type SessionState = "idle" | "busy" | "awaiting";

export class SessionControlError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 502 | 503,
  ) {
    super(message);
    this.name = "SessionControlError";
  }
}

export interface SessionDescriptor {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: ProviderId;
  /** Real provider behind a compatibility provider, when they differ. */
  agentProvider?: ProviderId;
  status: SessionState;
  model: string;
}

export interface SessionHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

/** One live session behind the existing even-terminal control routes. */
export interface LiveSession {
  readonly id: string;
  readonly provider: ProviderId;
  readonly agentProvider?: ProviderId;
  readonly cwd: string;
  readonly state: SessionState;
  describe(): Promise<SessionDescriptor>;
  prompt(text: string): Promise<void>;
  respondPermission(decision: string): Promise<void>;
  respondQuestion(answer: string): Promise<void>;
  interrupt(): Promise<void>;
  /** Attach a remembered native session when the app opens its SSE stream. */
  onConnect?(): Promise<void>;
  /** Recent local display history; native transcripts remain authoritative. */
  history?(): Promise<SessionHistoryEntry[]>;
  /** Re-emit the currently blocking interaction after an SSE reconnect. */
  replayPending?(): void;
  dispose(): void | Promise<void>;
}

/** Source-neutral lookup used by HTTP routes; a launch selects one catalog. */
export interface SessionCatalog {
  list(): Promise<SessionDescriptor[]>;
  get(id: string): Promise<LiveSession | undefined>;
  default(): Promise<LiveSession | undefined>;
  info(): Promise<{ provider: ProviderId; model: string }>;
  /** Optional capability: permanently remove a remembered session. Sources whose
   *  sessions are not the server's to forget — mux panes belong to the
   *  multiplexer — simply do not implement it. */
  forget?(id: string): Promise<void>;
  dispose(): void | Promise<void>;
}
