import fs from "node:fs";
import path from "node:path";

export type SourceMode = "mux" | "grok" | "owned";

export interface GrokConfig {
  bin: string;
  cwd: string;
  startupTimeoutMs: number;
  cancelTimeoutMs: number;
  shutdownTimeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export class GrokConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokConfigError";
  }
}

export function resolveSource(env: NodeJS.ProcessEnv): SourceMode {
  const raw = env.SOURCE;
  if (raw === undefined || raw === "" || raw === "mux") return "mux";
  if (raw === "grok") return "grok";
  if (raw === "owned") return "owned";
  throw new GrokConfigError(`invalid SOURCE "${raw}". Use mux, grok, or owned.`);
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
    throw new GrokConfigError(`invalid ${name} "${raw}". Use an integer from ${min} to ${max}.`);
  }
  return value;
}

function resolveCwd(raw: string | undefined, startupCwd: string): string {
  if (!raw?.trim()) throw new GrokConfigError("GROK_CWD is required when SOURCE=grok.");
  const requested = path.resolve(startupCwd, raw.trim());
  let canonical: string;
  try {
    canonical = fs.realpathSync(requested);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new GrokConfigError(`GROK_CWD is not a directory: ${requested}`);
    }
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    if (error instanceof GrokConfigError) throw error;
    throw new GrokConfigError(`GROK_CWD is not an accessible directory: ${requested}`);
  }
  return canonical;
}

function resolveBin(raw: string | undefined, startupCwd: string): string {
  const value = (raw ?? "grok").trim();
  if (!value || value.includes("\0")) throw new GrokConfigError("GROK_BIN must name one executable.");
  if (!value.includes("/")) return value;
  const requested = path.resolve(startupCwd, value);
  try {
    const canonical = fs.realpathSync(requested);
    if (!fs.statSync(canonical).isFile()) {
      throw new GrokConfigError(`GROK_BIN is not a file: ${requested}`);
    }
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof GrokConfigError) throw error;
    throw new GrokConfigError(`GROK_BIN is not executable: ${requested}`);
  }
}

export function resolveGrokConfig(
  env: NodeJS.ProcessEnv = process.env,
  startupCwd: string = process.cwd(),
): GrokConfig {
  if (resolveSource(env) !== "grok") {
    throw new GrokConfigError("Grok configuration requested while SOURCE is not grok.");
  }
  if (env.MUX?.trim()) {
    throw new GrokConfigError("SOURCE=grok cannot be combined with MUX; unset MUX.");
  }
  const childEnv = { ...env };
  delete childEnv.BRIDGE_TOKEN;
  return {
    cwd: resolveCwd(env.GROK_CWD, startupCwd),
    bin: resolveBin(env.GROK_BIN, startupCwd),
    startupTimeoutMs: integerSetting(env, "GROK_STARTUP_TIMEOUT_MS", 15_000, 1_000, 120_000),
    cancelTimeoutMs: integerSetting(env, "GROK_CANCEL_TIMEOUT_MS", 5_000, 250, 60_000),
    shutdownTimeoutMs: integerSetting(env, "GROK_SHUTDOWN_TIMEOUT_MS", 2_000, 250, 30_000),
    env: childEnv,
  };
}

export interface GrokVersion {
  major: number;
  minor: number;
  patch: number;
  display: string;
}

export function parseGrokVersion(output: string): GrokVersion | null {
  const match = output.match(/\bgrok\s+(\d+)\.(\d+)\.(\d+)\b/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    display: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function supportedGrokVersion(version: GrokVersion): boolean {
  if (version.major !== 0) return version.major > 0;
  if (version.minor !== 2) return version.minor > 2;
  return version.patch >= 103;
}
