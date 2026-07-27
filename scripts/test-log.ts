import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// log.ts resolves its paths and byte cap from the environment when it loads, so both are
// pointed at a scratch directory before the import — a test must never append to the real
// /tmp/even-better-*.log files a running server owns.
const dir = mkdtempSync(join(tmpdir(), "even-better-log-"));
process.env.LOG = "normal";
process.env.CONSOLE_LOG_FILE = join(dir, "console.log");
process.env.LOG_FILE = join(dir, "events.log");
process.env.LOG_MAX_BYTES = "1048576";
const { cappedAppender, consoleLogPath, installConsoleTee, logMaxBytes, sanitizeForLog } =
  await import("../src/log.js");
after(() => rmSync(dir, { recursive: true, force: true }));

// installConsoleTee replaces console.* for good, so capture the wrappers here — over an
// original that always throws, which is the EPIPE a closed stdout raises — and hand the
// pristine console back. The tests drive `tee` explicitly and the runner keeps a console.
const pristine = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const epipe = (): never => {
  throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
};
console.log = epipe;
console.info = epipe;
console.warn = epipe;
console.error = epipe;
installConsoleTee();
const tee = { log: console.log, error: console.error };
Object.assign(console, pristine);

function teeText(): string {
  return existsSync(consoleLogPath) ? readFileSync(consoleLogPath, "utf8") : "";
}

/** Tee lines written after `start` characters of the file, timestamps stripped. */
function teeSince(start: number): string[] {
  return teeText()
    .slice(start)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const stamped = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (.*)$/.exec(line);
      assert.ok(stamped, `tee line is not timestamped: ${line}`);
      return stamped[1];
    });
}

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

test("redacts-token-query", () => assert.deepEqual(
  sanitizeForLog({ query: { token: "secret", defaultProvider: "codex" } }),
  { query: { token: "[REDACTED]", defaultProvider: "codex" } },
));

test("keeps-token-counts", () => assert.deepEqual(
  sanitizeForLog({ inputTokens: 12, outputTokens: 3 }),
  { inputTokens: 12, outputTokens: 3 },
));

test("redacts-url-and-bearer", () => assert.deepEqual(
  sanitizeForLog({ url: "https://x.test?token=abc123&defaultProvider=codex", authorization: "Bearer abc123" }),
  { url: "https://x.test?token=[REDACTED]&defaultProvider=codex", authorization: "[REDACTED]" },
));

// A throw out of console.* reaches index.ts's uncaughtException handler, which logs via
// console.error and throws again: the loop that wrote 5.3 GB of tee file into tmpfs.
test("a dead console never throws out of console.log/error, and is still teed", () => {
  const start = teeText().length;
  assert.doesNotThrow(() => tee.log("stdout is gone"));
  assert.doesNotThrow(() => tee.error("stderr is gone"));
  assert.deepEqual(teeSince(start), ["LOG stdout is gone", "ERR stderr is gone"]);
});

test("the tee still redacts tokens", () => {
  const start = teeText().length;
  tee.log("Connect  : https://x.test/?token=abc123");
  assert.deepEqual(teeSince(start), ["LOG Connect  : https://x.test/?token=[REDACTED]"]);
});

test("consecutive duplicates collapse into one repeat line", () => {
  const start = teeText().length;
  tee.log("boom");
  tee.log("boom");
  tee.log("boom");
  tee.log("done");
  assert.deepEqual(teeSince(start), [
    "LOG boom",
    "LOG (previous line repeated 2 times)",
    "LOG done",
  ]);
});

// A run that never ends would otherwise be invisible until it stopped — which is exactly
// the runaway case, where the process is killed with the run still open.
test("a long repeat run is reported while it is still running", () => {
  const start = teeText().length;
  for (let i = 0; i < 2_001; i += 1) tee.log("spin");
  const lines = teeSince(start);
  assert.deepEqual(lines[0], "LOG spin");
  assert.deepEqual(
    lines.slice(1),
    ["LOG (previous line repeated 1000 times)", "LOG (previous line repeated 1000 times)"],
  );
  // Each flush resets the counter, so the run ends fully accounted for: 1 + 1000 + 1000.
  tee.log("stopped");
  assert.deepEqual(teeSince(start).slice(3), ["LOG stopped"]);
});

test("a non-repeating stream is unaffected", () => {
  const start = teeText().length;
  tee.log("alpha");
  tee.error("beta");
  tee.log("alpha");
  assert.deepEqual(teeSince(start), ["LOG alpha", "ERR beta", "LOG alpha"]);
});

test("capped appender keeps the earliest bytes and writes exactly one cap notice", () => {
  const path = join(dir, "capped.log");
  const append = cappedAppender(path, 64); // "line NN\n" is 8 bytes, so 8 lines fit exactly
  for (let i = 1; i <= 20; i += 1) append(`line ${String(i).padStart(2, "0")}`);
  const lines = linesOf(path);
  assert.deepEqual(lines.slice(0, 8), [
    "line 01", "line 02", "line 03", "line 04", "line 05", "line 06", "line 07", "line 08",
  ]);
  assert.deepEqual(lines.slice(8), ["… log capped at 64 bytes; further lines dropped"]);
  append("nothing after the cap");
  assert.deepEqual(linesOf(path), lines);
});

// The cap has to bound the file, not one process: a supervisor restarting a server that
// fails on every boot writes to the same path each time.
test("capped appender resumes from what is already on disk", () => {
  const path = join(dir, "capped-restart.log");
  for (let run = 0; run < 5; run += 1) {
    const append = cappedAppender(path, 64); // a fresh appender, as a restart would make
    for (let i = 1; i <= 20; i += 1) append(`line ${String(i).padStart(2, "0")}`);
  }
  const lines = linesOf(path);
  assert.deepEqual(lines.slice(0, 8), [
    "line 01", "line 02", "line 03", "line 04", "line 05", "line 06", "line 07", "line 08",
  ]);
  // One notice per run at most, and the file never runs away across restarts.
  assert.ok(readFileSync(path, "utf8").length < 64 + 5 * 60, `file grew to ${readFileSync(path, "utf8").length}`);
  assert.ok(lines.slice(8).every((line) => line.startsWith("… log capped at 64 bytes")));
});

test("capped appender counts UTF-8 bytes, not code units", () => {
  const path = join(dir, "capped-utf8.log");
  const append = cappedAppender(path, 10); // "ααα\n" is 7 bytes but 4 code units
  append("ααα");
  append("ααα");
  assert.deepEqual(linesOf(path), ["ααα", "… log capped at 10 bytes; further lines dropped"]);
});

test("LOG_MAX_BYTES sets the cap", () => assert.equal(logMaxBytes, 1_048_576));

// The event log is consumed with `jq` (docs/TROUBLESHOOTING.md), so its cap notice has to
// be JSON too — a prose line there aborts the reader at exactly the moment someone is
// diagnosing a runaway. Run in a child so a tiny cap does not affect the tee tests above.
test("the event log stays one parseable JSON object per line at the cap", () => {
  const events = join(dir, "capped-events.log");
  const entry = join(dir, "emit-events.mjs");
  const logModule = new URL("../src/log.ts", import.meta.url).href;
  writeFileSync(
    entry,
    `import { logEvent } from ${JSON.stringify(logModule)};\n`
      + `for (let i = 0; i < 40; i += 1) logEvent("out", "w1:p1", { type: "text_delta", text: "x".repeat(20) });\n`,
  );
  execFileSync(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), entry], {
    env: {
      ...process.env,
      LOG: "debug",
      LOG_FILE: events,
      CONSOLE_LOG_FILE: join(dir, "capped-events-console.log"),
      LOG_MAX_BYTES: "400",
    },
    stdio: "ignore",
  });

  const lines = linesOf(events);
  assert.ok(lines.length >= 2 && lines.length < 40, `expected a capped file, got ${lines.length} lines`);
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line) as { dir?: string; msg?: { logCappedBytes?: number } };
    } catch {
      throw new assert.AssertionError({ message: `event log line ${index + 1} is not JSON: ${line}` });
    }
  });
  assert.deepEqual(parsed.at(-1)?.msg, { logCappedBytes: 400 });
  assert.equal(parsed.at(-1)?.dir, "diag");
  assert.ok(parsed.slice(0, -1).every((entry) => entry.dir === "out"));
});
