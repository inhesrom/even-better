#!/usr/bin/env node

import path from "node:path";
import { resolveEvenBetterHome } from "./owned-config.js";
import { OwnedSessionStore, OwnedSessionStoreError } from "./owned-session-store.js";

const VERSION = "0.1.0";

function usage(): string {
  return `even-better ${VERSION}

Usage:
  even-better [--source owned|mux|grok] [--workspace-root <path> ...]
  even-better sessions
  even-better sessions remove <public-id>
  even-better sessions clear

Bare even-better starts owned mode. Its launch directory is the default workspace
root. Repeat --workspace-root to replace it with one or more approved roots.

Environment: WORKSPACE_ROOTS, EVEN_BETTER_HOME, SOURCE, and the server settings
documented in README.md remain supported. CLI workspace roots take precedence.`;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function runSessions(args: string[]): void {
  const store = new OwnedSessionStore(resolveEvenBetterHome(process.env, process.cwd()));
  try {
    if (args.length === 0) {
      const sessions = store.list();
      if (!sessions.length) {
        console.log("No remembered sessions.");
        return;
      }
      for (const session of sessions) {
        console.log(`${session.id}\t${session.agentProvider}\t${session.lastUsedAt}\t${session.cwd}`);
      }
      return;
    }
    if (args[0] === "remove" && args.length === 2) {
      store.remove(args[1]);
      console.log(`Forgot ${args[1]}. Native provider transcripts were not removed.`);
      return;
    }
    if (args[0] === "clear" && args.length === 1) {
      const count = store.clear();
      console.log(`Forgot ${count} remembered session${count === 1 ? "" : "s"}. Native provider transcripts were not removed.`);
      return;
    }
    fail("Use `even-better sessions`, `sessions remove <public-id>`, or `sessions clear`.");
  } catch (error) {
    if (error instanceof OwnedSessionStoreError) fail(error.message);
    throw error;
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] === "sessions") {
  runSessions(args.slice(1));
  process.exit(0);
}

let source: string | undefined;
const workspaceRoots: string[] = [];
const positionals: string[] = [];
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--source") {
    source = args[++index] ?? fail("--source requires owned, mux, or grok.");
  } else if (argument.startsWith("--source=")) {
    source = argument.slice("--source=".length);
  } else if (argument === "--workspace-root") {
    workspaceRoots.push(args[++index] ?? fail("--workspace-root requires a path."));
  } else if (argument.startsWith("--workspace-root=")) {
    workspaceRoots.push(argument.slice("--workspace-root=".length));
  } else if (argument.startsWith("-")) {
    fail(`unknown option ${argument}. Run even-better --help.`);
  } else {
    positionals.push(argument);
  }
}

if (positionals.some((value) => value !== "hook-install" && value !== "hook-uninstall")) {
  fail(`unknown command ${positionals[0]}. Run even-better --help.`);
}
if (source && source !== "owned" && source !== "mux" && source !== "grok") {
  fail(`invalid --source "${source}". Use owned, mux, or grok.`);
}
process.env.SOURCE = source ?? process.env.SOURCE ?? "owned";
if (workspaceRoots.length) {
  process.env.WORKSPACE_ROOTS = workspaceRoots.map((root) => path.resolve(process.cwd(), root)).join(path.delimiter);
}
process.argv = [process.argv[0], process.argv[1], ...positionals];
await import("./index.js");
