import { GrokSessionBridge } from "./grok-bridge.js";
import type { GrokConfig } from "./grok-config.js";
import type { LiveSession, SessionCatalog, SessionDescriptor } from "./session.js";

/** The Grok launch has exactly one process-backed session. */
export class GrokSessionCatalog implements SessionCatalog {
  private constructor(private readonly session: GrokSessionBridge) {}

  static async start(config: GrokConfig): Promise<GrokSessionCatalog> {
    const session = new GrokSessionBridge(config);
    await session.start();
    return new GrokSessionCatalog(session);
  }

  async list(): Promise<SessionDescriptor[]> {
    return [await this.session.describe()];
  }

  async get(id: string): Promise<LiveSession | undefined> {
    return id === this.session.id ? this.session : undefined;
  }

  async default(): Promise<LiveSession> {
    return this.session;
  }

  async info(): Promise<{ provider: "grok"; model: string }> {
    const descriptor = await this.session.describe();
    return { provider: "grok", model: descriptor.model };
  }

  dispose(): Promise<void> {
    return this.session.dispose();
  }
}
