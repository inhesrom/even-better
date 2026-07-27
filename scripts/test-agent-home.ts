import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeConfigDir, codexHome } from "../src/agent-home.js";

// These resolvers must agree across modules. transcript.ts hardcoded
// ~/.claude/projects while hook-install.ts honored CLAUDE_CONFIG_DIR, so with
// that variable set the installer wrote to one directory and the tailer read
// another — the transcript never resolved, and claude/codex panes are
// transcript-only, so the glasses showed no content at all.

function withEnv<T>(key: string, value: string | undefined, run: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("claudeConfigDir honors CLAUDE_CONFIG_DIR and falls back to ~/.claude", () => {
  assert.equal(withEnv("CLAUDE_CONFIG_DIR", undefined, claudeConfigDir), join(homedir(), ".claude"));
  assert.equal(withEnv("CLAUDE_CONFIG_DIR", "/tmp/custom-claude", claudeConfigDir), "/tmp/custom-claude");
  assert.equal(withEnv("CLAUDE_CONFIG_DIR", "  /tmp/padded  ", claudeConfigDir), "/tmp/padded");
  // Empty/whitespace is not a configured directory.
  assert.equal(withEnv("CLAUDE_CONFIG_DIR", "   ", claudeConfigDir), join(homedir(), ".claude"));
});

test("codexHome honors CODEX_HOME and falls back to ~/.codex", () => {
  assert.equal(withEnv("CODEX_HOME", undefined, codexHome), join(homedir(), ".codex"));
  assert.equal(withEnv("CODEX_HOME", "/tmp/custom-codex", codexHome), "/tmp/custom-codex");
  assert.equal(withEnv("CODEX_HOME", "   ", codexHome), join(homedir(), ".codex"));
});

test("the transcript tailer resolves under the same root the hook installer writes to", async () => {
  const { findSessionFile } = await import("../src/transcript.js");
  // A configured-but-empty directory must be searched (and simply miss), not
  // silently replaced by ~/.claude.
  const missing = withEnv("CLAUDE_CONFIG_DIR", "/tmp/even-better-no-such-claude-dir", () =>
    findSessionFile("11111111-1111-4111-8111-111111111111"),
  );
  assert.equal(missing, null);
});
