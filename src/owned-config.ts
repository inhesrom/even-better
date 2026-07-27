import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "./session.js";
import { parseWorkspaceRoots, OwnedWorkspaceCatalog, WorkspaceConfigError } from "./owned-workspaces.js";

export interface OwnedProviderConfig {
  bin: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  cancelTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface OwnedConfig {
  maxSessions: number;
  /** Options in the wizard's directory question; 0 means every eligible directory.
   *  An escape hatch: nobody has measured how long a menu the glasses render well. */
  directoryLimit: number;
  /** Sessions per page in the manage row's delete question. Unlike
   *  `directoryLimit` this has no "unlimited": eleven options did not render on a
   *  physical phone, so the menu always pages. */
  manageSessionLimit: number;
  /** Sessions per page in the pickup row's menu. Paged like `manageSessionLimit`
   *  and for the same measured reason: eleven options did not render. */
  pickupSessionLimit: number;
  /** How long after an SSE stream opens a synthetic row's first question is
   *  emitted. Sending it in the same tick is dropped by the app — see
   *  owned-row-question.ts. 500ms was measured on a physical phone; a slower
   *  device may need more. */
  setupQuestionDelayMs: number;
  homeDir?: string;
  workspaces: OwnedWorkspaceCatalog;
  providers: Partial<Record<ProviderId, OwnedProviderConfig>>;
}

export function resolveEvenBetterHome(
  env: NodeJS.ProcessEnv = process.env,
  startupCwd: string = process.cwd(),
): string {
  const override = env.EVEN_BETTER_HOME?.trim();
  if (override) return path.resolve(startupCwd, override);
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"), "even-better");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "even-better");
  }
  const stateHome = env.XDG_STATE_HOME?.trim();
  return path.join(stateHome ? path.resolve(startupCwd, stateHome) : path.join(os.homedir(), ".local", "state"), "even-better");
}

export class OwnedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnedConfigError";
  }
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OwnedConfigError(`invalid ${name} "${raw}". Use an integer from ${min} to ${max}.`);
  }
  return value;
}

function executableFromPath(name: string, env: NodeJS.ProcessEnv, startupCwd: string): string | null {
  const value = name.trim();
  if (!value || value.includes("\0")) return null;
  const candidates: string[] = [];
  if (value.includes("/") || value.includes("\\")) {
    candidates.push(path.resolve(startupCwd, value));
  } else {
    const extensions = process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) candidates.push(path.join(directory, `${value}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      const canonical = fs.realpathSync(candidate);
      if (!fs.statSync(canonical).isFile()) continue;
      fs.accessSync(canonical, fs.constants.X_OK);
      return canonical;
    } catch {
      // Missing executables are omitted from the phone wizard.
    }
  }
  return null;
}

export function resolveOwnedConfig(
  env: NodeJS.ProcessEnv = process.env,
  startupCwd: string = process.cwd(),
): OwnedConfig {
  if (env.SOURCE !== "owned") {
    throw new OwnedConfigError("Owned configuration requested while SOURCE is not owned.");
  }
  if (env.MUX?.trim()) {
    throw new OwnedConfigError("SOURCE=owned cannot be combined with MUX; unset MUX.");
  }
  let roots: string[];
  try {
    roots = parseWorkspaceRoots(env.WORKSPACE_ROOTS, startupCwd);
  } catch (error) {
    if (error instanceof WorkspaceConfigError) throw new OwnedConfigError(error.message);
    throw error;
  }
  const childEnv = { ...env };
  delete childEnv.BRIDGE_TOKEN;
  // 15s was not enough headroom: the Claude Agent SDK cold start missed it four
  // times in a row on a loaded machine, failing session creation outright.
  const startupTimeoutMs = integerSetting(env, "OWNED_STARTUP_TIMEOUT_MS", 30_000, 1_000, 120_000);
  const cancelTimeoutMs = integerSetting(env, "OWNED_CANCEL_TIMEOUT_MS", 5_000, 250, 60_000);
  const shutdownTimeoutMs = integerSetting(env, "OWNED_SHUTDOWN_TIMEOUT_MS", 2_000, 250, 30_000);
  const providers: Partial<Record<ProviderId, OwnedProviderConfig>> = {};
  for (const [provider, setting, fallback] of [
    ["claude", "CLAUDE_BIN", "claude"],
    ["codex", "CODEX_BIN", "codex"],
    ["grok", "GROK_BIN", "grok"],
  ] as const) {
    const bin = executableFromPath(env[setting] ?? fallback, env, startupCwd);
    if (bin) {
      providers[provider] = { bin, env: childEnv, startupTimeoutMs, cancelTimeoutMs, shutdownTimeoutMs };
    }
  }
  if (!Object.keys(providers).length) {
    throw new OwnedConfigError("No supported agent executable was found. Install Claude, Codex, or Grok, or set its *_BIN path.");
  }
  return {
    maxSessions: integerSetting(env, "MAX_OWNED_SESSIONS", 6, 1, 100),
    directoryLimit: integerSetting(env, "WIZARD_DIRECTORY_LIMIT", 0, 0, 200),
    manageSessionLimit: integerSetting(env, "MANAGE_SESSION_LIMIT", 4, 1, 50),
    pickupSessionLimit: integerSetting(env, "PICKUP_SESSION_LIMIT", 4, 1, 50),
    setupQuestionDelayMs: integerSetting(env, "SETUP_QUESTION_DELAY_MS", 500, 0, 5_000),
    homeDir: resolveEvenBetterHome(env, startupCwd),
    workspaces: new OwnedWorkspaceCatalog(roots),
    providers,
  };
}
