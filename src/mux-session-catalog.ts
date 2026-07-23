import path from "node:path";
import {
  disposeAll,
  focusedOrFirstBridge,
  getOrCreateBridge,
  refreshAgents,
} from "./bridge.js";
import { readCodexModel } from "./codex-transcript.js";
import { getMux } from "./multiplexer.js";
import { extractModel } from "./parse.js";
import type { LiveSession, ProviderId, SessionCatalog, SessionDescriptor } from "./session.js";
import { readClaudeModel } from "./transcript.js";

function providerForAgent(agent: string | undefined): ProviderId {
  return agent === "codex" ? "codex" : "claude";
}

/** Adapter around the existing pane manager. All pane behavior stays in bridge.ts. */
export class MuxSessionCatalog implements SessionCatalog {
  async list(): Promise<SessionDescriptor[]> {
    const agents = await refreshAgents();
    return agents.map((a) => ({
      id: a.paneId,
      title: `${a.agent} · ${path.basename(a.cwd || "/")}`,
      timestamp: new Date().toISOString(),
      cwd: a.cwd,
      provider: providerForAgent(a.agent),
      status: focusedOrFirstBridge([a])?.state ?? "idle",
      model: this.modelFor(a.agent, a.sessionId),
    }));
  }

  get(id: string): Promise<LiveSession | undefined> {
    return getOrCreateBridge(id);
  }

  async default(): Promise<LiveSession | undefined> {
    const agents = await refreshAgents();
    return focusedOrFirstBridge(agents);
  }

  async info(): Promise<{ provider: ProviderId; model: string }> {
    const agents = await refreshAgents();
    const target = agents.find((a) => a.focused) ?? agents[0];
    let model = this.modelFor(target?.agent, target?.sessionId);
    if (!model && target?.agent === "claude") {
      model = extractModel(await getMux().read(target.paneId, 5));
    }
    return { provider: providerForAgent(target?.agent), model: model || "Unknown" };
  }

  dispose(): void {
    disposeAll();
    getMux().dispose?.();
  }

  private modelFor(agent: string | undefined, sessionId: string | undefined): string {
    if (!sessionId) return "";
    return agent === "codex"
      ? (readCodexModel(sessionId) ?? "")
      : (readClaudeModel(sessionId) ?? "");
  }
}
