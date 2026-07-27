import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import readline from "node:readline";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { getBridge } from "./bridge.js";
import { emit, getMessages, sseHandler } from "./sse.js";
import { getMux, setMux, type Multiplexer } from "./multiplexer.js";
import { HerdrMultiplexer, herdrAvailable } from "./herdr.js";
import { CmuxMultiplexer, cmuxAvailable } from "./cmux.js";
import { logEvent, eventLogPath, logMode, writesEventLog, consoleLogPath, installConsoleTee } from "./log.js";
import { startExpose, exposeProviderNames } from "./expose.js";
import { startHookEndpoint, hookSocketPath } from "./hook-endpoint.js";
import {
  installClaudeHooks,
  uninstallClaudeHooks,
  installCodexHooks,
  uninstallCodexHooks,
  codexHooksFeatureEnabled,
  codexConfigPath,
  hooksInstalled,
} from "./hook-install.js";
import { maskToken, printConnect } from "./connect-url.js";
import { resolveSource, type SourceMode } from "./grok-config.js";
import { MuxSessionCatalog } from "./mux-session-catalog.js";
import { resolveOwnedConfig } from "./owned-config.js";
import { OwnedSessionCatalog } from "./owned-session-catalog.js";
import { SessionControlError, type ProviderId, type SessionCatalog } from "./session.js";

// Tee the terminal diagnostics to a file before anything logs, so the lines needed to
// diagnose a live issue are on disk without re-running with a flag.
installConsoleTee();

const VERSION = "0.1.0";
const INSTANCE_ID = process.env.INSTANCE_ID ?? String(process.pid);

// CLI: install/uninstall the self-hook and exit, before touching the mux or server.
// (Stage 1 of docs/HOOK-MIGRATION.md — reporting only; the bridge is not wired yet.)
if (process.argv.includes("hook-install")) {
  // Explicit opt-in command (this invocation IS the consent) — install both agents and
  // walk the Codex user through the one manual step (trust) we can't safely automate.
  try {
    const claude = installClaudeHooks();
    console.log(`installed even-better Claude hooks → ${claude}`);
    const codex = installCodexHooks();
    console.log(`installed even-better Codex hooks  → ${codex}`);
    console.log("");
    console.log("Codex needs two manual steps (it won't run untrusted hooks):");
    if (codexHooksFeatureEnabled() === false) {
      console.log(`  1. enable hooks: set \`hooks = true\` under \`[features]\` in ${codexConfigPath()}`);
    } else {
      console.log("  1. hooks feature is already enabled ✓");
    }
    console.log("  2. run `/hooks` inside Codex, review the even-better hooks, and trust them.");
    console.log("");
    console.log("then restart already-running Claude/Codex panes to pick up the hooks.");
  } catch (err) {
    console.error(`hook-install failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}
if (process.argv.includes("hook-uninstall")) {
  try {
    const claude = uninstallClaudeHooks();
    console.log(claude ? `removed even-better Claude hooks ← ${claude}` : "no ~/.claude/settings.json to clean");
    const codex = uninstallCodexHooks();
    console.log(codex ? `removed even-better Codex hooks  ← ${codex}` : "no Codex hooks.json to clean");
    console.log("(Codex trust entries in config.toml, if any, are yours to remove via `/hooks`.)");
  } catch (err) {
    console.error(`hook-uninstall failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "auto") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`error: invalid PORT "${raw}". Use a number, 0, or auto.`);
    return process.exit(1);
  }
  return port;
}

const listenPort = parsePort(process.env.PORT);

// Pick the multiplexer once, before anything touches it. MUX=cmux|herdr forces
// it. Otherwise: use whichever backend is present; if BOTH are, never guess —
// prompt on a TTY, and fail fast without one (so nothing silently mirrors the
// wrong terminal). A missing backend surfaces later as NOT REACHABLE.
type MuxChoice = { name: string; make: () => Multiplexer };

function promptMux(found: MuxChoice[]): Promise<Multiplexer> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = found.map((f, i) => `  ${i + 1}) ${f.name}`).join("\n");
  return new Promise((resolve) => {
    rl.question(`\nMultiple multiplexers detected. Choose one:\n${list}\n> `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      const chosen = found[Number(a) - 1] ?? found.find((f) => f.name === a) ?? found[0];
      resolve(chosen.make());
    });
  });
}

async function selectMux(): Promise<Multiplexer> {
  const pick = (process.env.MUX ?? "").toLowerCase();
  if (pick === "herdr") return new HerdrMultiplexer();
  if (pick === "cmux") return new CmuxMultiplexer();
  if (pick) {
    console.error(`error: unknown MUX "${pick}". Use: herdr, cmux.`);
    return process.exit(1);
  }
  const found: MuxChoice[] = [];
  if (await herdrAvailable()) found.push({ name: "herdr", make: () => new HerdrMultiplexer() });
  if (await cmuxAvailable()) found.push({ name: "cmux", make: () => new CmuxMultiplexer() });
  if (found.length <= 1) return (found[0]?.make ?? (() => new HerdrMultiplexer()))();
  if (!process.stdin.isTTY) {
    const names = found.map((f) => f.name);
    console.error(
      `error: multiple multiplexers detected (${names.join(", ")}) and no TTY to prompt. ` +
        `Set MUX=${names.join("|")} to choose.`,
    );
    return process.exit(1);
  }
  return promptMux(found);
}

let sourceMode: SourceMode;
try {
  sourceMode = resolveSource(process.env);
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
let catalog!: SessionCatalog;

// The bearer token is process-local by default. Set BRIDGE_TOKEN explicitly
// only when a stable token is wanted for a specific launch.
function resolveToken(): string {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  return randomBytes(24).toString("hex");
}
const TOKEN = resolveToken();
let defaultProvider: ProviderId = sourceMode === "owned" ? "codex" : "claude";

function controlError(res: Response, err: unknown): void {
  const status = err instanceof SessionControlError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function publicBasePath(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return normalizeBasePath(new URL(raw).pathname);
  } catch {
    console.error(`error: invalid PUBLIC_BASE_URL "${raw}"`);
    return process.exit(1);
  }
}

function normalizePublicAccess(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "none") return undefined;
  if (t === "tailscale-funnel" || t === "funnel") return "funnel";
  if (exposeProviderNames().includes(t)) return t;
  const providers = ["tailscale-funnel", ...exposeProviderNames().filter((n) => n !== "funnel")];
  console.error(`error: unknown PUBLIC_ACCESS "${raw}". Use: none, ${providers.join(", ")}.`);
  return process.exit(1);
}

function resolveQr(raw: string | undefined): boolean {
  if (raw === undefined || raw === "1") return true;
  if (raw === "0") return false;
  console.error(`error: invalid QR "${raw}". Use 1 or 0.`);
  return process.exit(1);
}

function validatePublicAccessBind(raw: string | undefined): void {
  if (!publicAccess) return;
  const b = (raw ?? "auto").trim().toLowerCase();
  if (!b || b === "auto" || b === "local" || b === "localhost" || b === "127.0.0.1") return;
  console.error("error: PUBLIC_ACCESS requires BIND_HOST=auto, local, localhost, or 127.0.0.1 because providers proxy to 127.0.0.1.");
  process.exit(1);
}

const publicAccess = normalizePublicAccess(process.env.PUBLIC_ACCESS);
const publicBase = process.env.PUBLIC_BASE_URL?.trim();
if (publicBase && publicAccess) {
  console.error("error: PUBLIC_BASE_URL and PUBLIC_ACCESS are mutually exclusive; use one external URL source.");
  process.exit(1);
}
if (publicBase && listenPort === 0) {
  console.error(
    "error: PUBLIC_BASE_URL requires a fixed PORT because external proxies cannot follow auto-assigned local ports.",
  );
  process.exit(1);
}
const publicBaseMountPath = publicBasePath(publicBase);
const funnelFallbackPath = publicAccess === "funnel" ? `/eb/${INSTANCE_ID}` : "";
const basePaths = [...new Set([publicBaseMountPath, funnelFallbackPath].filter(Boolean))];
const qrEnabled = resolveQr(process.env.QR);
validatePublicAccessBind(process.env.BIND_HOST);

/** Constant-time token check (avoids leaking the token via comparison timing). */
function tokenMatches(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (!tokenMatches(provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const api = express.Router();
app.use("/api", auth, api);
for (const basePath of basePaths) app.use(`${basePath}/api`, auth, api);

// Log every inbound app request (except the SSE stream itself) for debugging.
api.use((req, _res, next) => {
  if (req.path !== "/events") {
    const sessionId =
      (req.body?.sessionId as string) ??
      (req.query.sessionId as string) ??
      "";
    logEvent("in", sessionId, {
      method: req.method,
      path: req.path,
      ...(req.method === "POST" ? { body: req.body } : { query: req.query }),
    });
  }
  next();
});

// ── even-terminal protocol surface ─────────────────────

api.get("/events", (req, res) => {
  sseHandler(req, res);
  // Push a status snapshot to the fresh client so it knows immediately
  // whether a turn is running. Without this, an app that connects while the
  // agent is idle waits forever for a status/result that never comes (status
  // events are only emitted on transitions).
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    void catalog
      .get(sessionId)
      .then(async (session) => {
        if (session) {
          await session.onConnect?.();
          session.replayPending?.();
          emit(sessionId, {
            type: "status",
            state: session.state,
            sessionId,
            provider: session.provider,
            ...(session.agentProvider ? { agentProvider: session.agentProvider } : {}),
          });
        }
      })
      .catch(() => undefined);
  }
});

api.get("/sessions", async (_req, res) => {
  try {
    const sessions = (await catalog.list()).map((session) => ({
      id: session.id,
      title: session.title,
      timestamp: session.timestamp,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.agentProvider ? { agentProvider: session.agentProvider } : {}),
      status: session.status,
    }));
    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], error: (err as Error).message });
  }
});

api.get("/info", async (_req, res) => {
  let model = "Unknown";
  let provider: ProviderId = defaultProvider;
  try {
    const info = await catalog.info();
    model = info.model;
    provider = info.provider;
    defaultProvider = provider;
  } catch {
    // leave model unknown
  }
  res.json({
    account: {},
    model,
    version: `${VERSION} (even-better)`,
    provider,
  });
});

api.get("/update-check", (_req, res) => {
  res.json({
    currentVersion: VERSION,
    newestVersion: null,
    updateAvailable: false,
  });
});

api.post("/prompt", async (req, res) => {
  const { text, sessionId } = (req.body ?? {}) as {
    text?: string;
    sessionId?: string | null;
  };
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  try {
    const session = sessionId ? await catalog.get(sessionId) : await catalog.default();
    if (!session) {
      res.status(404).json({ error: "No agent pane found" });
      return;
    }
    console.log(`[prompt] session=${session.id} text=${text.slice(0, 80)}`);
    await session.prompt(text);
    res.status(202).json({
      ok: true,
      sessionId: session.id,
      provider: session.provider,
      ...(session.agentProvider ? { agentProvider: session.agentProvider } : {}),
    });
  } catch (err) {
    controlError(res, err);
  }
});

api.post("/permission-response", async (req, res) => {
  const { sessionId, decision } = (req.body ?? {}) as {
    sessionId?: string;
    decision?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  try {
    const session = await catalog.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.respondPermission(decision || "deny");
    res.json({ ok: true });
  } catch (err) {
    controlError(res, err);
  }
});

api.post("/question-response", async (req, res) => {
  const { sessionId, answer } = (req.body ?? {}) as {
    sessionId?: string;
    answer?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  try {
    const session = await catalog.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.respondQuestion(answer || "skip");
    res.json({ ok: true });
  } catch (err) {
    controlError(res, err);
  }
});

api.post("/interrupt", async (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  try {
    const session = await catalog.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.interrupt();
    res.json({ ok: true });
  } catch (err) {
    controlError(res, err);
  }
});

api.get("/status", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  try {
    const session = await catalog.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      state: session.state,
      sessionId,
      provider: session.provider,
      ...(session.agentProvider ? { agentProvider: session.agentProvider } : {}),
    });
  } catch (err) {
    controlError(res, err);
  }
});

api.get("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const after = parseInt((req.query.after as string) ?? "0", 10) || 0;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  try {
    const session = await catalog.get(sessionId);
    res.json({
      messages: getMessages(sessionId, after),
      state: session?.state ?? "idle",
      sessionId,
      provider: session?.provider ?? null,
      ...(session?.agentProvider ? { agentProvider: session.agentProvider } : {}),
    });
  } catch (err) {
    controlError(res, err);
  }
});

api.get("/sessions/:id/history", async (req, res) => {
  try {
    const session = await catalog.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ history: await session.history?.() ?? [] });
  } catch (err) {
    controlError(res, err);
  }
});

// ── startup ────────────────────────────────────────────

// An IPv4 in 100.64.0.0/10 is Tailscale's CGNAT range — reachable from any
// device on the same tailnet, so the app can connect over it off-Wi-Fi.
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function ipv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const lanAddress = (): string | undefined => ipv4s().find((ip) => !isTailscale(ip));
const tailscaleAddress = (): string | undefined => ipv4s().find(isTailscale);

function withAuth(base: string): string {
  const u = new URL(base);
  u.searchParams.set("token", TOKEN);
  u.searchParams.set("defaultProvider", defaultProvider);
  return u.toString();
}

const urlFor = (host: string, port: number): string => withAuth(`http://${host}:${port}`);
const appUrlFromBase = (base: string): string => withAuth(base);

interface Bind {
  label: string;
  bindHost: string;
  qrHost?: string; // direct modes: host to encode in the QR (undefined => offline fallback)
}

function resolveBind(): Bind {
  const raw = (process.env.BIND_HOST ?? "auto").trim().toLowerCase();
  const b = raw === "auto" ? (publicAccess || publicBase ? "local" : "lan") : raw;
  if (b === "lan") return { label: "LAN (same Wi-Fi)", bindHost: "0.0.0.0", qrHost: lanAddress() };
  if (b === "local" || b === "localhost")
    return { label: "local only (same machine)", bindHost: "127.0.0.1", qrHost: "localhost" };
  if (b === "tailscale") {
    const ts = tailscaleAddress();
    if (!ts) {
      console.error("BIND_HOST=tailscale but no Tailscale (100.64/10) address found — is Tailscale up?");
      process.exit(1);
    }
    return { label: "Tailscale (private tailnet)", bindHost: ts, qrHost: ts };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(b)) {
    return { label: `${b} only`, bindHost: b, qrHost: b === "0.0.0.0" ? lanAddress() : b };
  }
  console.error(`error: unknown BIND_HOST "${raw}". Use: auto, lan, local, tailscale, or a literal IP.`);
  return process.exit(1);
}

const bind = resolveBind();

// Start external resources only after every static launch setting has passed
// validation, so a configuration error cannot orphan a detached Grok child.
try {
  if (sourceMode === "mux") {
    setMux(await selectMux());
    catalog = new MuxSessionCatalog();
  } else {
    catalog = new OwnedSessionCatalog(resolveOwnedConfig(process.env));
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}

const server = app.listen(listenPort, bind.bindHost, async () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  console.log("");
  console.log(`  even-better v${VERSION}`);
  console.log(`  Instance : ${INSTANCE_ID}`);
  console.log(`  Source   : ${sourceMode === "mux" ? `mux (${getMux().name})` : "owned (per-session agent)"}`);
  console.log(`  Bind     : ${bind.label}`);
  console.log(`  Local    : http://${bind.bindHost === "0.0.0.0" ? "127.0.0.1" : bind.bindHost}:${actualPort}`);
  if (basePaths.length > 0) console.log(`  Paths    : ${basePaths.join(", ")}`);
  if (publicAccess) console.log(`  Public   : ${publicAccess}`);
  console.log(`  Token    : ${maskToken(TOKEN)}${process.env.BRIDGE_TOKEN ? " (from BRIDGE_TOKEN)" : " (ephemeral)"}`);
  console.log(`  Log mode : ${logMode}`);
  console.log(`  Log      : ${writesEventLog ? eventLogPath : "off"}`);
  if (logMode !== "off") console.log(`  Diag log : ${consoleLogPath}`);
  console.log("");
  try {
    const sessions = await catalog.list();
    defaultProvider = (await catalog.info()).provider;
    for (const session of sessions) {
      console.log(
        `  agent : ${session.provider} session=${session.id} status=${session.status} cwd=${session.cwd}`,
      );
    }
    if (sessions.length === 0 && sourceMode === "mux") {
      console.log(`  agent : none yet — start claude or codex inside ${getMux().name}; it's picked up automatically (no restart).`);
    }
  } catch (err) {
    const source = sourceMode === "mux" ? getMux().name : "owned agents";
    console.error(`  ${source} : NOT REACHABLE — ${(err as Error).message}`);
  }

  // Receive self-hook reports. With SELF_HOOK=1 (Stage 3) they drive the matching
  // bridge's status/session via the per-pane cutover; off by default (log-only).
  // Install with `pnpm start hook-install`; remove with `hook-uninstall`.
  const selfHook = process.env.SELF_HOOK === "1";
  if (sourceMode !== "mux") {
    console.log(`  Hooks    : not used by the ${sourceMode} source`);
  } else {
    try {
      await startHookEndpoint((r) => {
        const extra = [
          r.sessionId ? `session=${r.sessionId}` : "",
          r.toolName ? `tool=${r.toolName}` : "",
          r.transcriptPath ? "hasPath" : "",
        ].filter(Boolean).join(" ");
        const pane = r.paneId || `pid:${r.pid ?? "?"}`;
        console.log(`  [hook] ${r.mux}/${pane} ${r.agent} ${r.event} seq=${r.seq}${extra ? " " + extra : ""}`);
        if (selfHook && r.paneId) {
          // Env-primary routing: r.paneId == the mux paneId. (pid fallback for env-less
          // reports + reconciliation land in Stage 3b.)
          getBridge(r.paneId)?.onHookReport(r);
        }
      });
      console.log(
        `  Hooks    : ${hookSocketPath()} (${selfHook ? "SELF_HOOK on — driving bridges" : "log-only; SELF_HOOK=1 to drive"})`,
      );
      // SELF_HOOK drives bridges only if our hook is actually installed — else no reports
      // arrive and the pane silently never cuts over. Warn so it isn't a silent no-op.
      // `inst.codex` = our hook.json entry + the feature on; Codex ALSO needs a `/hooks` trust
      // we can't verify here, so we never claim Codex "will report" — only flag it isn't set up
      // and, when it is, remind about the unverifiable trust step.
      if (selfHook) {
        const inst = hooksInstalled();
        if (!inst.claude && !inst.codex) {
          console.log("  ⚠ SELF_HOOK=1 but no even-better hooks are installed — no reports will arrive.");
          console.log("    Run `pnpm start hook-install`, then restart the agent panes.");
        } else {
          // Warn per agent that isn't set up (a codex-only pane must not be silently missed).
          if (!inst.claude) console.log("  ⚠ SELF_HOOK=1 — Claude hooks not installed; run hook-install.");
          if (!inst.codex)
            console.log("  ⚠ SELF_HOOK=1 — Codex hooks not active (need hooks.json + `[features] hooks=true`); run hook-install / enable the feature.");
          else console.log("    Codex: hooks installed — they report only once trusted via `/hooks` (not verifiable here).");
        }
      }
    } catch (err) {
      console.error(`  Hooks    : disabled — ${(err as Error).message}`);
    }
  }

  if (publicBase) {
    console.log("");
    printConnect("Scan to connect", appUrlFromBase(publicBase), qrEnabled);
    return;
  }

  if (publicAccess) {
    // The public-access provider prints the one QR itself, once its URL is up.
    startExpose(publicAccess, actualPort, appUrlFromBase, {
      fallbackPath: funnelFallbackPath,
      instanceId: INSTANCE_ID,
      qrEnabled,
    });
    return;
  }

  const host = bind.qrHost ?? "localhost";
  if (!bind.qrHost) console.log("  (no LAN address found — showing localhost, which a phone can't reach)");
  console.log("");
  printConnect("Scan to connect", urlFor(host, actualPort), qrEnabled);
});

// The selected catalog owns its live sessions and any child processes.
let teardownPromise: Promise<void> | undefined;
function teardown(): Promise<void> {
  teardownPromise ??= Promise.resolve(catalog.dispose());
  return teardownPromise;
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${process.env.PORT} already in use — choose another PORT or leave it unset for auto.`);
  } else {
    console.error(`[bridge] server error: ${err.message}`);
  }
  void teardown().finally(() => process.exit(1));
});

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void teardown().finally(() => process.exit(code));
}
// A repeated signal force-quits. teardown() is bounded (every provider dispose
// has a timeout), but this keeps Ctrl-C escapable if one ever wedges — expose.ts
// deliberately no longer installs its own exit-forcing signal handlers.
function onSignal(code: number): void {
  if (shuttingDown) {
    console.error("[bridge] second signal — exiting without finishing teardown");
    process.exit(code);
  }
  shutdown(code);
}
process.on("SIGINT", () => onSignal(0));
process.on("SIGTERM", () => onSignal(0));

// A dead terminal is not a reason to lose live agent sessions: a closed/severed
// stdio pipe surfaces as one of these codes, thrown synchronously on write or
// emitted as 'error' on the stream. Everything else keeps the shutdown policy.
const STDIO_DEATH_CODES = new Set(["EPIPE", "EIO", "ERR_STREAM_DESTROYED"]);
function isStdioDeath(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && STDIO_DEATH_CODES.has(code);
}
// Logging a fatal can itself throw (that is how a broken stdout turned one EPIPE
// into millions of re-entries); drop the nested fatal instead of re-processing it.
let handlingFatal = false;
function safeLog(message: string): void {
  try {
    console.error(message);
  } catch {
    // The console is gone — the process still serves the phone.
  }
}
function onFatal(label: string, value: unknown, detail: string): void {
  if (handlingFatal) return;
  handlingFatal = true;
  try {
    safeLog(`[bridge] ${label}: ${detail}`);
    if (isStdioDeath(value)) return;
    if (sourceMode !== "mux") shutdown(1);
  } finally {
    handlingFatal = false;
  }
}
process.on("uncaughtException", (err) => {
  onFatal("uncaught", err, `${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
  onFatal("unhandled rejection", reason, String(reason));
});
// Async writes report failure by emitting 'error' rather than throwing; without a
// listener that becomes an uncaught exception. Only stdio death is swallowed —
// any other write error is still surfaced through the fatal path.
for (const stream of [process.stdout, process.stderr]) {
  // One report per stream: reporting a stream's own failure writes to a stream
  // that can fail the same way, and these emissions are async, so the re-entrancy
  // guard above would not catch the ping-pong.
  let reported = false;
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (isStdioDeath(err) || reported) return;
    reported = true;
    onFatal("stdio error", err, err.message);
  });
}

// Re-export for potential programmatic use / tests.
export { emit };
