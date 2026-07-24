import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  parseGrokVersion,
  resolveGrokConfig,
  resolveSource,
  supportedGrokVersion,
} from "../src/grok-config.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

test("mux remains the default source", () => {
  assert.equal(resolveSource({}), "mux");
  assert.equal(resolveSource({ SOURCE: "mux" }), "mux");
  assert.equal(resolveSource({ SOURCE: "grok" }), "grok");
  assert.equal(resolveSource({ SOURCE: "owned" }), "owned");
  assert.throws(() => resolveSource({ SOURCE: "GROK" }), /invalid SOURCE/);
});

test("Grok configuration is explicit, bounded, canonical, and does not forward the bridge token", () => {
  const config = resolveGrokConfig({
    SOURCE: "grok",
    GROK_CWD: ".",
    GROK_BIN: fakeGrok,
    GROK_STARTUP_TIMEOUT_MS: "2000",
    GROK_CANCEL_TIMEOUT_MS: "500",
    GROK_SHUTDOWN_TIMEOUT_MS: "750",
    BRIDGE_TOKEN: "do-not-forward",
    XAI_API_KEY: "forward-to-grok",
  });
  assert.equal(config.cwd, process.cwd());
  assert.equal(config.bin, fakeGrok);
  assert.equal(config.startupTimeoutMs, 2_000);
  assert.equal(config.cancelTimeoutMs, 500);
  assert.equal(config.shutdownTimeoutMs, 750);
  assert.equal(config.env.BRIDGE_TOKEN, undefined);
  assert.equal(config.env.XAI_API_KEY, "forward-to-grok");
});

test("Grok configuration rejects incompatible and inaccessible launches", () => {
  assert.throws(
    () => resolveGrokConfig({ SOURCE: "grok", MUX: "cmux", GROK_CWD: "." }),
    /cannot be combined with MUX/,
  );
  assert.throws(
    () => resolveGrokConfig({ SOURCE: "grok", GROK_CWD: "/tmp/even-better-does-not-exist" }),
    /not an accessible directory/,
  );
  assert.throws(
    () => resolveGrokConfig({ SOURCE: "grok", GROK_CWD: ".", GROK_BIN: "/tmp/missing-grok" }),
    /not executable/,
  );
  assert.throws(
    () => resolveGrokConfig({ SOURCE: "grok", GROK_CWD: ".", GROK_CANCEL_TIMEOUT_MS: "0" }),
    /invalid GROK_CANCEL_TIMEOUT_MS/,
  );
});

test("Grok version policy accepts 0.2.103 and newer", () => {
  const minimum = parseGrokVersion("grok 0.2.103 (abc) [stable]");
  const old = parseGrokVersion("grok 0.2.102");
  assert.ok(minimum && supportedGrokVersion(minimum));
  assert.ok(old && !supportedGrokVersion(old));
  assert.equal(parseGrokVersion("unknown"), null);
});
