import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEvenBetterHome } from "./owned-config.js";
import type { ProviderId } from "./session.js";

const SESSION_ID = /^owned:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface RememberedSessionMetadata {
  version: 1;
  id: string;
  agentProvider: ProviderId;
  cwd: string;
  nativeSessionId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  firstPrompt?: string;
}

export interface StoredHistoryEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

interface LeaseData {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export class OwnedSessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnedSessionStoreError";
  }
}

function isProvider(value: unknown): value is ProviderId {
  return value === "claude" || value === "codex" || value === "grok";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseMetadata(value: unknown): RememberedSessionMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1
    || typeof item.id !== "string"
    || !SESSION_ID.test(item.id)
    || !isProvider(item.agentProvider)
    || typeof item.cwd !== "string"
    || typeof item.nativeSessionId !== "string"
    || !item.nativeSessionId
    || typeof item.model !== "string"
    || !isIsoDate(item.createdAt)
    || !isIsoDate(item.updatedAt)
    || !isIsoDate(item.lastUsedAt)
    || (item.firstPrompt !== undefined && typeof item.firstPrompt !== "string")
  ) return null;
  return item as unknown as RememberedSessionMetadata;
}

function parseHistory(value: unknown): StoredHistoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    (item.role !== "user" && item.role !== "assistant")
    || typeof item.text !== "string"
    || !item.text
    || !isIsoDate(item.timestamp)
  ) return null;
  return item as unknown as StoredHistoryEntry;
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** User-private, atomic metadata and append-only display history for owned sessions. */
export class OwnedSessionStore {
  readonly homeDir: string;
  readonly sessionsDir: string;

  constructor(homeDir: string = resolveEvenBetterHome()) {
    this.homeDir = path.resolve(homeDir);
    this.sessionsDir = path.join(this.homeDir, "sessions");
  }

  list(): RememberedSessionMetadata[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions: RememberedSessionMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(`owned:${entry.name}`)) continue;
      const metadata = this.readMetadata(path.join(this.sessionsDir, entry.name, "metadata.json"));
      if (metadata && metadata.id === `owned:${entry.name}`) sessions.push(metadata);
    }
    return sessions.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  }

  get(id: string): RememberedSessionMetadata | undefined {
    return this.readMetadata(path.join(this.sessionDirectory(id), "metadata.json")) ?? undefined;
  }

  save(metadata: RememberedSessionMetadata): void {
    const parsed = parseMetadata(metadata);
    if (!parsed) throw new OwnedSessionStoreError("Refusing to persist invalid owned-session metadata.");
    const directory = this.ensureSessionDirectory(metadata.id);
    const target = path.join(directory, "metadata.json");
    const temporary = path.join(directory, `.metadata-${process.pid}-${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, serialized, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    const history = path.join(directory, "history.jsonl");
    const historyHandle = fs.openSync(history, "a", 0o600);
    fs.closeSync(historyHandle);
    fs.chmodSync(history, 0o600);
  }

  appendHistory(id: string, entry: StoredHistoryEntry): void {
    if (!parseHistory(entry)) throw new OwnedSessionStoreError("Refusing to persist invalid owned-session history.");
    const directory = this.ensureSessionDirectory(id);
    const target = path.join(directory, "history.jsonl");
    const handle = fs.openSync(target, "a", 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify(entry)}\n`, undefined, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.chmodSync(target, 0o600);
  }

  history(id: string, limit = 100): StoredHistoryEntry[] {
    let data: string;
    try {
      data = fs.readFileSync(path.join(this.sessionDirectory(id), "history.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = data.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = parseHistory(JSON.parse(line) as unknown);
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
    return entries.slice(-Math.max(0, limit));
  }

  acquireLease(id: string): () => void {
    const directory = this.ensureSessionDirectory(id);
    const target = path.join(directory, "lease.json");
    this.removeStaleLease(target);
    const lease: LeaseData = {
      token: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = fs.openSync(target, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(lease)}\n`, "utf8");
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new OwnedSessionStoreError(`Session ${id} is attached to another even-better server. Stop that server before resuming or removing it.`);
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.readLease(target);
      if (current?.token !== lease.token) return;
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }

  remove(id: string): void {
    const directory = this.sessionDirectory(id);
    const metadata = this.get(id);
    if (!metadata) throw new OwnedSessionStoreError(`Remembered session not found: ${id}`);
    const lease = path.join(directory, "lease.json");
    this.removeStaleLease(lease);
    if (fs.existsSync(lease)) {
      throw new OwnedSessionStoreError(`Session ${id} is actively attached. Stop the owning even-better server first.`);
    }
    fs.rmSync(directory, { recursive: true, force: false });
  }

  clear(): number {
    const sessions = this.list();
    for (const session of sessions) {
      const lease = path.join(this.sessionDirectory(session.id), "lease.json");
      this.removeStaleLease(lease);
      if (fs.existsSync(lease)) {
        throw new OwnedSessionStoreError(`Session ${session.id} is actively attached. Stop the owning even-better server before clearing remembered sessions.`);
      }
    }
    for (const session of sessions) fs.rmSync(this.sessionDirectory(session.id), { recursive: true, force: false });
    return sessions.length;
  }

  private ensureSessionDirectory(id: string): string {
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.homeDir, 0o700);
    fs.chmodSync(this.sessionsDir, 0o700);
    const directory = this.sessionDirectory(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    return directory;
  }

  private sessionDirectory(id: string): string {
    const match = id.match(SESSION_ID);
    if (!match) throw new OwnedSessionStoreError(`Invalid owned-session id: ${id}`);
    return path.join(this.sessionsDir, match[1].toLowerCase());
  }

  private readMetadata(target: string): RememberedSessionMetadata | null {
    try {
      return parseMetadata(JSON.parse(fs.readFileSync(target, "utf8")) as unknown);
    } catch {
      return null;
    }
  }

  private readLease(target: string): LeaseData | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const lease = parsed as Record<string, unknown>;
      if (
        typeof lease.token !== "string"
        || typeof lease.pid !== "number"
        || typeof lease.hostname !== "string"
        || !isIsoDate(lease.startedAt)
      ) return null;
      return lease as unknown as LeaseData;
    } catch {
      return null;
    }
  }

  private removeStaleLease(target: string): void {
    if (!fs.existsSync(target)) return;
    const lease = this.readLease(target);
    const active = lease && (lease.hostname !== os.hostname() || processExists(lease.pid));
    if (active) return;
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
