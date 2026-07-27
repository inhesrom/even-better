import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { resolveOwnedConfig } from "../src/owned-config.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-config-"));
after(() => rm(root, { recursive: true, force: true }));

test("owned config is explicit, bounded, strips the bridge token, and omits missing agents", () => {
  const config = resolveOwnedConfig({
    SOURCE: "owned",
    WORKSPACE_ROOTS: root,
    CLAUDE_BIN: path.join(root, "missing-claude"),
    CODEX_BIN: fakeCodex,
    GROK_BIN: fakeGrok,
    MAX_OWNED_SESSIONS: "8",
    OWNED_STARTUP_TIMEOUT_MS: "2000",
    OWNED_CANCEL_TIMEOUT_MS: "500",
    OWNED_SHUTDOWN_TIMEOUT_MS: "750",
    BRIDGE_TOKEN: "do-not-forward",
    XAI_API_KEY: "forward",
    EVEN_BETTER_HOME: path.join(root, "state"),
  });
  assert.equal(config.maxSessions, 8);
  assert.equal(config.pickupSessionLimit, 4);
  assert.equal(config.homeDir, path.join(root, "state"));
  assert.equal(config.providers.claude, undefined);
  assert.equal(config.providers.codex?.bin, fakeCodex);
  assert.equal(config.providers.grok?.bin, fakeGrok);
  assert.equal(config.providers.codex?.env.BRIDGE_TOKEN, undefined);
  assert.equal(config.providers.grok?.env.XAI_API_KEY, "forward");
  assert.equal(config.providers.grok?.startupTimeoutMs, 2_000);
});

test("owned config defaults roots to launch cwd and rejects mux combinations, invalid caps, and no executables", () => {
  const implicit = resolveOwnedConfig({ SOURCE: "owned", GROK_BIN: fakeGrok }, root);
  assert.deepEqual(implicit.workspaces.roots, [root]);
  assert.throws(() => resolveOwnedConfig({ SOURCE: "owned", WORKSPACE_ROOTS: root, MUX: "cmux", GROK_BIN: fakeGrok }), /cannot be combined/);
  assert.throws(() => resolveOwnedConfig({ SOURCE: "owned", WORKSPACE_ROOTS: root, GROK_BIN: fakeGrok, MAX_OWNED_SESSIONS: "0" }), /invalid MAX_OWNED_SESSIONS/);
  assert.throws(() => resolveOwnedConfig({ SOURCE: "owned", WORKSPACE_ROOTS: root, GROK_BIN: fakeGrok, PICKUP_SESSION_LIMIT: "0" }), /invalid PICKUP_SESSION_LIMIT/);
  assert.equal(resolveOwnedConfig({ SOURCE: "owned", GROK_BIN: fakeGrok, PICKUP_SESSION_LIMIT: "9" }, root).pickupSessionLimit, 9);
  assert.throws(() => resolveOwnedConfig({
    SOURCE: "owned",
    WORKSPACE_ROOTS: root,
    CLAUDE_BIN: path.join(root, "no-claude"),
    CODEX_BIN: path.join(root, "no-codex"),
    GROK_BIN: path.join(root, "no-grok"),
  }), /No supported agent executable/);
});
