import { appendFileSync, statSync } from "node:fs";

export type LogMode = "off" | "normal" | "debug" | "trace";

function resolveLogMode(): LogMode {
  const mode = (process.env.LOG ?? "normal").trim().toLowerCase();
  if (mode === "off" || mode === "normal" || mode === "debug" || mode === "trace") return mode;
  console.error(`error: invalid LOG "${process.env.LOG}". Use: off, normal, debug, or trace.`);
  return process.exit(1);
}

export const logMode = resolveLogMode();

// Every message exchanged with the app is appended here as one JSON line:
// {"t":"<iso>","dir":"out"|"in","sessionId":"w1:pQ","msg":{...}}
// "out" = SSE event pushed to the app, "in" = HTTP request from the app,
// "diag" = internal diagnostics (blocked-menu parsing, permission attempts).
export const eventLogPath =
  process.env.LOG_FILE ?? `/tmp/even-better-${process.env.INSTANCE_ID ?? process.pid}.events.log`;

export const writesEventLog = logMode !== "off";
export const tracesStream = logMode === "trace";
export const logsVerboseSse = logMode === "trace";

// The human-readable diagnostic stream (`[hook]`, `[bridge]`, `[sse]`, the boot banner, …)
// goes to the terminal; teeing it here too means the lines needed to diagnose a live issue
// are already on disk without re-running with an extra flag. Separate from the JSON event
// log so `tools/` parsers stay clean.
export const consoleLogPath =
  process.env.CONSOLE_LOG_FILE ?? `/tmp/even-better-${process.env.INSTANCE_ID ?? process.pid}.log`;

const DEFAULT_LOG_MAX_BYTES = 64 * 1024 * 1024;

function resolveLogMaxBytes(): number {
  const raw = process.env.LOG_MAX_BYTES;
  if (raw === undefined) return DEFAULT_LOG_MAX_BYTES;
  const bytes = Number(raw.trim());
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : DEFAULT_LOG_MAX_BYTES;
}

/** Per-file byte budget for this process's log output (`LOG_MAX_BYTES`). */
export const logMaxBytes = resolveLogMaxBytes();

/** Append whole lines to `filePath` until this process has written `maxBytes`, then write
 *  one cap notice and drop everything after. The EARLIEST bytes are the ones kept, on
 *  purpose: a runaway loop is diagnosed from the boot banner and the first stack trace, so
 *  this must never rotate or keep the tail. Best effort — fs errors are swallowed, exactly
 *  like the direct appends this replaced. */
export function cappedAppender(
  filePath: string,
  maxBytes: number = logMaxBytes,
  // The notice has to speak the file's own format: the event log is consumed with `jq`
  // (docs/TROUBLESHOOTING.md), so a prose line there would abort the reader.
  capNotice: (maxBytes: number) => string = (bytes) => `… log capped at ${bytes} bytes; further lines dropped`,
): (line: string) => void {
  // Seeded from what is already on disk so the cap bounds the FILE, not one process:
  // the default paths carry a pid, but `LOG_FILE`/`INSTANCE_ID` pin a stable path, and a
  // crash-looping server would otherwise re-earn the whole budget on every restart.
  let written = ((): number => {
    try {
      return statSync(filePath).size;
    } catch {
      return 0; // not created yet
    }
  })();
  let capped = false;
  return (line: string): void => {
    if (capped) return;
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text); // UTF-8 length: the file grows in bytes, not code units
    const over = written + bytes > maxBytes;
    try {
      appendFileSync(filePath, over ? `${capNotice(maxBytes)}\n` : text);
      // Latch only on a write that landed, so one transient fs error cannot silence
      // the rest of the log.
      if (over) capped = true;
      else written += bytes;
    } catch {
      // best effort — never let logging break its caller
    }
  };
}

/** Repeats are reported at least this often, so a hot loop is visible in the log while it
 *  is still running instead of only once it stops. 5M repeats cost 5000 lines. */
const REPEAT_FLUSH_EVERY = 1_000;

/** Collapse consecutive identical messages into one repeat line. A hot loop (an EPIPE
 *  storm re-entering index.ts's uncaughtException handler) otherwise writes the same
 *  line millions of times. Console tee only — the event log stays one JSON object per
 *  line. Compares the message, not the emitted line, whose timestamp is always new. */
function dedupingWriter(append: (line: string) => void): {
  write: (tag: string, message: string) => void;
  flush: () => void;
} {
  let last: { tag: string; message: string } | null = null;
  let repeats = 0;
  const flush = (): void => {
    if (last === null || repeats === 0) return;
    append(`${new Date().toISOString()} ${last.tag} (previous line repeated ${repeats} times)`);
    repeats = 0;
  };
  return {
    flush,
    write: (tag: string, message: string): void => {
      if (last !== null) {
        if (last.tag === tag && last.message === message) {
          repeats += 1;
          if (repeats >= REPEAT_FLUSH_EVERY) flush();
          return;
        }
        flush();
      }
      last = { tag, message };
      append(`${new Date().toISOString()} ${tag} ${redactString(message)}`);
    },
  };
}

/** Tee console.{log,info,warn,error} to `consoleLogPath` (timestamped + token-redacted,
 *  consecutive duplicates collapsed, capped at `logMaxBytes`). Call once at startup,
 *  before the banner, so everything shown is captured. Off with LOG=off. Best-effort —
 *  neither a file error nor a dead console breaks a console call. */
export function installConsoleTee(): void {
  if (logMode === "off") return;
  const { write, flush } = dedupingWriter(cappedAppender(consoleLogPath));
  // Without this a run of repeats that is still open at exit is never recorded, so the
  // very loop this collapses would leave a short log with no trace of it.
  process.on("exit", flush);
  const level: Array<["log" | "info" | "warn" | "error", string]> = [
    ["log", "LOG"],
    ["info", "INF"],
    ["warn", "WRN"],
    ["error", "ERR"],
  ];
  for (const [method, tag] of level) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      try {
        orig(...args);
      } catch {
        // A closed stdout throws EPIPE from here. It must not escape console.*:
        // index.ts's uncaughtException handler logs via console.error, so a throw
        // re-enters it forever — that loop once wrote 5.3 GB of tee file into tmpfs.
      }
      try {
        const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        write(tag, text);
      } catch {
        // best effort — never let logging break a console call
      }
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSensitiveKey(key: string): boolean {
  const k = key.replace(/[-_]/g, "").toLowerCase();
  return (
    k === "authorization" ||
    k === "apikey" ||
    k.endsWith("apikey") ||
    k.endsWith("password") ||
    k.endsWith("secret") ||
    k.endsWith("token")
  );
}

function redactString(value: string): string {
  return value
    .replace(/(\btoken=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(\bToken\s*:\s*)[^\s(]+/g, "$1[REDACTED]"); // the "Token : <value>" banner line (colon, not the token= URL form)
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeForLog(v);
  }
  return out;
}

// Stays one JSON object per line even at the cap, so `jq` over the event log never trips.
const appendEventLine = cappedAppender(eventLogPath, logMaxBytes, (bytes) =>
  JSON.stringify({ t: new Date().toISOString(), dir: "diag", sessionId: "", msg: { logCappedBytes: bytes } }));

export function logEvent(
  dir: "out" | "in" | "diag",
  sessionId: string,
  msg: unknown,
): void {
  if (!writesEventLog) return;
  const type = isRecord(msg) && typeof msg.type === "string" ? msg.type : "";
  if (logMode === "normal" && dir === "out" && type === "text_delta") return;
  const line = JSON.stringify({ t: new Date().toISOString(), dir, sessionId, msg: sanitizeForLog(msg) });
  // Synchronous append (inside the appender) preserves emission order in the log. Async
  // appendFile can land out of order, which made tool_start/tool_end look reversed even
  // though the wire order was correct. Event volume is low; the cost is fine.
  appendEventLine(line);
}
