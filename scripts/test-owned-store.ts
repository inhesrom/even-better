import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { OwnedSessionStore, type RememberedSessionMetadata } from "../src/owned-session-store.js";

const scratch = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-store-"));
after(() => rm(scratch, { recursive: true, force: true }));

function metadata(id: string): RememberedSessionMetadata {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    agentProvider: "claude",
    cwd: scratch,
    nativeSessionId: "native-session",
    model: "model",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
}

test("owned store writes atomic private metadata and normalized JSONL history", () => {
  const store = new OwnedSessionStore(path.join(scratch, "state"));
  const id = "owned:22222222-2222-4222-8222-222222222222";
  store.save(metadata(id));
  store.appendHistory(id, { role: "user", text: "hello", timestamp: new Date().toISOString() });
  const directory = path.join(store.sessionsDir, id.slice("owned:".length));
  assert.equal(fs.statSync(path.join(directory, "metadata.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, "history.jsonl")).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(directory).some((entry) => entry.endsWith(".tmp")));
  assert.equal(store.list()[0]?.id, id);
  assert.deepEqual(store.history(id).map(({ role, text }) => ({ role, text })), [{ role: "user", text: "hello" }]);
});

test("a lease is never visible without its payload, so a racing server cannot reclaim it", () => {
  const store = new OwnedSessionStore(path.join(scratch, "lease-window-state"));
  const id = "owned:44444444-4444-4444-8444-444444444444";
  store.save(metadata(id));
  const release = store.acquireLease(id);
  const lease = path.join(store.sessionsDir, id.slice("owned:".length), "lease.json");
  // acquireLease writes the payload first and links it into place, so the file
  // is complete the instant it exists. When it was open("wx")-then-written, a
  // second server reading it inside that window parsed nothing, judged the
  // lease abandoned, unlinked it, and both servers attached the same session.
  const parsed: unknown = JSON.parse(fs.readFileSync(lease, "utf8"));
  assert.ok(parsed && typeof parsed === "object");
  assert.equal((parsed as { pid: number }).pid, process.pid);
  // No temp file is left behind by the link.
  const directory = path.join(store.sessionsDir, id.slice("owned:".length));
  assert.ok(!fs.readdirSync(directory).some((entry) => entry.endsWith(".tmp")));
  // A second acquisition is refused while the first is held.
  assert.throws(() => store.acquireLease(id), /attached to another even-better server/);
  release();
  // Released, it can be taken again.
  store.acquireLease(id)();
});

test("an unreadable but freshly written lease is not treated as abandoned", () => {
  const store = new OwnedSessionStore(path.join(scratch, "lease-corrupt-state"));
  const id = "owned:55555555-5555-4555-8555-555555555555";
  store.save(metadata(id));
  const directory = path.join(store.sessionsDir, id.slice("owned:".length));
  fs.mkdirSync(directory, { recursive: true });
  // Simulate the torn/partial file a racing writer would leave.
  fs.writeFileSync(path.join(directory, "lease.json"), "", { mode: 0o600 });
  assert.throws(() => store.acquireLease(id), /attached to another even-better server/);
});

test("removal refuses a live lease and forgets only even-better state after release", () => {
  const store = new OwnedSessionStore(path.join(scratch, "leased-state"));
  const id = "owned:33333333-3333-4333-8333-333333333333";
  store.save(metadata(id));
  const release = store.acquireLease(id);
  assert.throws(() => store.remove(id), /actively attached/);
  release();
  store.remove(id);
  assert.equal(store.get(id), undefined);
});
