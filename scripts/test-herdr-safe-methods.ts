import assert from "node:assert/strict";
import { test } from "node:test";
import { call } from "../src/herdr.js";

// AGENTS.md "Critical invariants": never call server.* on the herdr socket —
// server.reload_config / server.stop kill herdr itself. call() enforces an
// allowlist, and that guard runs BEFORE any socket connection, so these
// assertions never touch a real herdr even on a machine running one.

const FORBIDDEN = [
  "server.stop",
  "server.reload_config",
  "server.handoff",
  "server.restart",
  "server",
  "SERVER.STOP",
  "pane.destroy",
  "workspace.destroy",
  "agent.kill",
];

for (const method of FORBIDDEN) {
  test(`herdr call() refuses "${method}"`, async () => {
    await assert.rejects(call(method), /method not allowed/);
  });
}

test("herdr call() refuses every unlisted method rather than defaulting open", async () => {
  await assert.rejects(call(""), /method not allowed/);
  await assert.rejects(call("__proto__"), /method not allowed/);
  await assert.rejects(call("constructor"), /method not allowed/);
  // Near-misses of allowed names are still refused — the check is exact.
  await assert.rejects(call("pane.read2"), /method not allowed/);
  await assert.rejects(call(" pane.read"), /method not allowed/);
});
