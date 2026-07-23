export type ProviderId = "claude" | "codex" | "grok";
export type SessionState = "idle" | "busy" | "awaiting";

export class SessionControlError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502 | 503,
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
  status: SessionState;
  model: string;
}

/** One live session behind the existing even-terminal control routes. */
export interface LiveSession {
  readonly id: string;
  readonly provider: ProviderId;
  readonly cwd: string;
  readonly state: SessionState;
  describe(): Promise<SessionDescriptor>;
  prompt(text: string): Promise<void>;
  respondPermission(decision: string): Promise<void>;
  respondQuestion(answer: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): void | Promise<void>;
}

/** Source-neutral lookup used by HTTP routes; a launch selects one catalog. */
export interface SessionCatalog {
  list(): Promise<SessionDescriptor[]>;
  get(id: string): Promise<LiveSession | undefined>;
  default(): Promise<LiveSession | undefined>;
  info(): Promise<{ provider: ProviderId; model: string }>;
  dispose(): void | Promise<void>;
}
