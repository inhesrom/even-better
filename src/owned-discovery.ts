// Discovery of coding-agent sessions the user started outside even-better — a
// plain `claude` or `codex` CLI in a terminal. Every provider-filesystem read
// for the pickup row lives here, behind one seam the catalog consumes, the way
// screen artifacts live in screen-timeline.ts. Nothing here spawns a process,
// and nothing here surfaces an error to a caller: a failed scan contributes an
// empty list, because discovery feeding list() must never take the row — or the
// session list — down with it.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { codexHome } from "./agent-home.js";
import { findCodexSessionFile, readCodexModel } from "./codex-transcript.js";
import type { OwnedWorkspaceCatalog } from "./owned-workspaces.js";
import type { ProviderId } from "./session.js";
import { findSessionFile, readClaudeModel } from "./transcript.js";

/** Providers discoverable in v1. Grok is excluded by decision, not omission:
 *  there is no population of terminal Grok sessions worth adopting. */
export type PickupProvider = Extract<ProviderId, "claude" | "codex">;

export interface ExternalSessionCandidate {
  agentProvider: PickupProvider;
  nativeSessionId: string;
  /** As recorded by the CLI; canonicalized only at adopt (workspaces.resolve). */
  cwd: string;
  /** One-liner for menu labels: claude customTitle/summary/firstPrompt; codex
   *  first user message (capped head read); "" when the session has none. */
  title: string;
  /** Git branch at the session's end, when the provider recorded one. */
  branch?: string;
  lastModifiedMs: number;
}

export interface ExternalSessionInspection {
  /** readClaudeModel/readCodexModel result; "" when the transcript has none yet. */
  model: string;
  firstPrompt?: string;
}

/** What the catalog depends on; tests substitute a fake implementing exactly this. */
export interface ExternalSessionSource {
  /** Adoptable-looking sessions: recent, workspace-eligible, requested providers
   *  only, newest first. TTL-cached; `fresh` bypasses the cache (user gestures
   *  pass it, list()'s row-existence probe does not). Never rejects. */
  candidates(providers: readonly PickupProvider[], fresh?: boolean): Promise<ExternalSessionCandidate[]>;
  /** Adopt-time re-read: confirms the native transcript still exists and pulls
   *  model + first prompt. Null when the file is gone. Never rejects. */
  inspect(candidate: ExternalSessionCandidate): Promise<ExternalSessionInspection | null>;
}

interface ClaudeSessionListing {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
}

/** Injection points for unit tests; production uses the defaults. The claude
 *  lister is a structural subset of the SDK's SDKSessionInfo so fakes need no
 *  SDK import. */
export interface DiscoveryDeps {
  listClaudeSessions?: (options: { includeProgrammatic: boolean; limit: number }) => Promise<ClaudeSessionListing[]>;
  codexSessionsRoot?: () => string;
  now?: () => number;
}

/** Only sessions touched this recently are offered. A constant, not a knob:
 *  anything older is better reached from a terminal (`claude --resume` shows the
 *  full history), and the window is what keeps the codex scan to a handful of
 *  date directories. */
export const PICKUP_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

/** list()'s row-existence probe re-scans at most this often. */
const DISCOVERY_TTL_MS = 30_000;
/** Per-provider scan bound; a slow filesystem contributes [] instead of latency. */
const DISCOVERY_TIMEOUT_MS = 3_000;
/** Safety cap on the SDK's listSessions call. */
const LIST_SESSIONS_LIMIT = 200;
/** session_meta is line 0; this is more than any observed meta line needs. */
const SESSION_META_READ_BYTES = 8_192;
/** Adopt-time excerpt scan cap — the first user message is near the file head. */
const FIRST_PROMPT_READ_BYTES = 65_536;

const ROLLOUT_UUID = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve with the scan's result, or [] once the bound elapses — never reject. */
function bounded<T>(work: Promise<T[]>): Promise<T[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS);
    timer.unref();
    work
      .then((result) => resolve(result))
      .catch(() => resolve([]))
      .finally(() => clearTimeout(timer));
  });
}

/** Read up to `cap` bytes from the head of a file, resolving with "" on any error. */
function readHead(file: string, cap: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(file, { start: 0, end: cap - 1 });
    stream.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(buffer);
      size += buffer.length;
      if (size >= cap) stream.close();
    });
    stream.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(""));
  });
}

export class ExternalSessionDiscovery implements ExternalSessionSource {
  private cache: ExternalSessionCandidate[] = [];
  private cacheAt = 0;
  private cachedProviders = "";
  private inflight: Promise<ExternalSessionCandidate[]> | null = null;

  constructor(
    private readonly workspaces: Pick<OwnedWorkspaceCatalog, "isEligible">,
    private readonly deps: DiscoveryDeps = {},
  ) {}

  candidates(providers: readonly PickupProvider[], fresh = false): Promise<ExternalSessionCandidate[]> {
    if (!providers.length) return Promise.resolve([]);
    const key = [...providers].sort().join(",");
    const now = (this.deps.now ?? Date.now)();
    if (!fresh && key === this.cachedProviders && now - this.cacheAt < DISCOVERY_TTL_MS) {
      return Promise.resolve(this.cache);
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.scan(providers)
      .then((found) => {
        this.cache = found;
        this.cacheAt = (this.deps.now ?? Date.now)();
        this.cachedProviders = key;
        return found;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async inspect(candidate: ExternalSessionCandidate): Promise<ExternalSessionInspection | null> {
    try {
      if (candidate.agentProvider === "claude") {
        if (!findSessionFile(candidate.nativeSessionId)) return null;
        return {
          model: readClaudeModel(candidate.nativeSessionId) ?? "",
          ...(candidate.title ? { firstPrompt: candidate.title } : {}),
        };
      }
      if (!findCodexSessionFile(candidate.nativeSessionId)) return null;
      return {
        model: readCodexModel(candidate.nativeSessionId) ?? "",
        ...(candidate.title ? { firstPrompt: candidate.title } : {}),
      };
    } catch {
      return null;
    }
  }

  private async scan(providers: readonly PickupProvider[]): Promise<ExternalSessionCandidate[]> {
    const scans = providers.map((provider) =>
      bounded(provider === "claude" ? this.scanClaude() : this.scanCodex()),
    );
    const found = (await Promise.all(scans)).flat();
    return found.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  private async scanClaude(): Promise<ExternalSessionCandidate[]> {
    const list =
      this.deps.listClaudeSessions ??
      (async (options) => {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        return sdk.listSessions(options);
      });
    // includeProgrammatic: false is the SDK's own "terminal /resume parity"
    // filter — it drops sdk-driven sessions, even-better's included. The
    // remembered-id dedupe in adoptable() is the backstop either way.
    const sessions = await list({ includeProgrammatic: false, limit: LIST_SESSIONS_LIMIT });
    const now = (this.deps.now ?? Date.now)();
    const found: ExternalSessionCandidate[] = [];
    for (const session of sessions) {
      const cwd = session.cwd;
      if (!session.sessionId || !cwd || !path.isAbsolute(cwd)) continue;
      if (now - session.lastModified > PICKUP_RECENCY_MS) continue;
      if (!this.workspaces.isEligible(cwd)) continue;
      found.push({
        agentProvider: "claude",
        nativeSessionId: session.sessionId,
        cwd,
        title: session.customTitle || session.summary || session.firstPrompt || "",
        ...(session.gitBranch ? { branch: session.gitBranch } : {}),
        lastModifiedMs: session.lastModified,
      });
    }
    return found;
  }

  /** The windowed form of findCodexSessionFile's DFS: rollouts live under
   *  sessions/YYYY/MM/DD, so only the window's date directories are read — no
   *  tree walk. The date convention (local vs UTC) is unverified upstream, so
   *  both spellings of each day are probed; they are usually the same path. */
  private async scanCodex(): Promise<ExternalSessionCandidate[]> {
    const root = (this.deps.codexSessionsRoot ?? (() => join(codexHome(), "sessions")))();
    if (!existsSync(root)) return [];
    const now = (this.deps.now ?? Date.now)();
    const days = new Set<string>();
    for (let back = 0; back * 86_400_000 <= PICKUP_RECENCY_MS; back++) {
      const at = new Date(now - back * 86_400_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      days.add(join(root, String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())));
      days.add(join(root, String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate())));
    }
    const found: ExternalSessionCandidate[] = [];
    for (const day of days) {
      let names: string[];
      try {
        names = readdirSync(day);
      } catch {
        continue;
      }
      for (const name of names) {
        const match = ROLLOUT_UUID.exec(name);
        if (!match) continue;
        const file = join(day, name);
        try {
          const mtimeMs = statSync(file).mtimeMs;
          if (now - mtimeMs > PICKUP_RECENCY_MS) continue;
          const candidate = await this.readCodexMeta(file, match[1], mtimeMs);
          if (!candidate) continue;
          // Titles are read at scan time so the pick menu can identify the
          // session; the set is already filtered, so this stays a handful of
          // capped head reads.
          candidate.title = (await this.readCodexFirstPrompt(file)) ?? "";
          found.push(candidate);
        } catch {
          // Unreadable rollout — not a candidate.
        }
      }
    }
    return found;
  }

  private async readCodexMeta(
    file: string,
    filenameId: string,
    lastModifiedMs: number,
  ): Promise<ExternalSessionCandidate | null> {
    const head = await readHead(file, SESSION_META_READ_BYTES);
    const line = head.split("\n", 1)[0];
    if (!line) return null;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(entry) || entry.type !== "session_meta" || !isRecord(entry.payload)) return null;
    const payload = entry.payload;
    const metaId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : typeof payload.id === "string" && payload.id
        ? payload.id
        : filenameId;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    if (!cwd || !path.isAbsolute(cwd) || !this.workspaces.isEligible(cwd)) return null;
    // session_meta lines carry an optional flattened `git` sibling (GitInfo);
    // best-effort — absent or reshaped just means no branch in the menu.
    const branch = isRecord(payload.git) && typeof payload.git.branch === "string" ? payload.git.branch : "";
    return {
      agentProvider: "codex",
      nativeSessionId: metaId,
      cwd,
      title: "",
      ...(branch ? { branch } : {}),
      lastModifiedMs,
    };
  }

  private async readCodexFirstPrompt(file: string): Promise<string | undefined> {
    const head = await readHead(file, FIRST_PROMPT_READ_BYTES);
    for (const line of head.split("\n")) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry) || !isRecord(entry.payload)) continue;
      const payload = entry.payload;
      if (entry.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
        const text = payload.message.trim();
        if (text) return text;
      }
      if (entry.type === "response_item" && payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
        const text = payload.content
          .map((block) => (isRecord(block) && block.type === "input_text" && typeof block.text === "string" ? block.text : ""))
          .join("")
          .trim();
        if (text) return text;
      }
    }
    return undefined;
  }
}
