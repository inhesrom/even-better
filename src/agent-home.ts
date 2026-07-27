// Where the agent CLIs keep their per-user state.
//
// These must agree across modules. The transcript tailer and the hook installer
// both resolve Claude's config directory, and when they disagree the failure is
// silent and total: with CLAUDE_CONFIG_DIR set, the installer wrote to the
// configured directory while the tailer looked in ~/.claude, so the transcript
// never resolved — and claude/codex panes are transcript-only, so the glasses
// showed no content at all.

import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** Codex's home directory: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? raw : join(homedir(), ".codex");
}
