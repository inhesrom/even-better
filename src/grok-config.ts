// Grok's child-process config shape and version policy. Grok itself is reached
// through owned mode (GrokOwnedAgent); the dedicated SOURCE=grok catalog and
// bridge were a fork of the common owned bridge and have been retired, so the
// standalone GROK_CWD/GROK_BIN resolver went with them — owned mode discovers
// executables through owned-config.ts.

export type SourceMode = "mux" | "owned";

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
  if (raw === "owned") return "owned";
  if (raw === "grok") {
    throw new GrokConfigError(
      'SOURCE=grok has been retired. Use SOURCE=owned and pick Grok when the session asks for an agent — it runs the same ACP child.',
    );
  }
  throw new GrokConfigError(`invalid SOURCE "${raw}". Use mux or owned.`);
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
