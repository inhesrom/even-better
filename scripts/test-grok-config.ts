import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGrokVersion, resolveSource, supportedGrokVersion } from "../src/grok-config.js";

test("mux remains the default source", () => {
  assert.equal(resolveSource({}), "mux");
  assert.equal(resolveSource({ SOURCE: "mux" }), "mux");
  assert.equal(resolveSource({ SOURCE: "owned" }), "owned");
  assert.throws(() => resolveSource({ SOURCE: "GROK" }), /invalid SOURCE/);
});

test("the retired SOURCE=grok points at owned mode instead of failing opaquely", () => {
  assert.throws(() => resolveSource({ SOURCE: "grok" }), /SOURCE=grok has been retired/);
  assert.throws(() => resolveSource({ SOURCE: "grok" }), /SOURCE=owned/);
});

test("Grok version policy accepts 0.2.103 and newer", () => {
  const minimum = parseGrokVersion("grok 0.2.103 (abc) [stable]");
  const old = parseGrokVersion("grok 0.2.102");
  assert.ok(minimum && supportedGrokVersion(minimum));
  assert.ok(old && !supportedGrokVersion(old));
  assert.equal(parseGrokVersion("unknown"), null);
});
