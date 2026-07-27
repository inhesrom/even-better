import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnedCommand } from "../src/owned-agent.js";
import {
  commandText,
  isDestructive,
  parseAnswer,
  parseCommandInput,
  resolveCommand,
  suggestCommands,
} from "../src/owned-commands.js";

const command = (name: string, extra: Partial<OwnedCommand> = {}): OwnedCommand => ({
  name,
  description: `run ${name}`,
  ...extra,
});

const COMMANDS: OwnedCommand[] = [
  command("compact"),
  command("context"),
  command("clear"),
  command("usage", { aliases: ["cost", "stats"] }),
  command("grill"),
  command("grill-me"),
  command("research", { argumentHint: "<topic>" }),
  command("plugin:deploy"),
];

test("the slash marker is required, in typed or spoken form", () => {
  assert.equal(parseCommandInput("/compact"), "compact");
  assert.equal(parseCommandInput("  /research auth flow "), "research auth flow");
  assert.equal(parseCommandInput("slash compact"), "compact");
  assert.equal(parseCommandInput("slash-compact"), "compact");
  assert.equal(parseCommandInput("SLASH Compact"), "Compact");
  // Prose that merely contains or starts with a command name stays prose.
  assert.equal(parseCommandInput("compact the context"), null);
  assert.equal(parseCommandInput("please slash compact"), null);
  assert.equal(parseCommandInput(""), null);
  assert.equal(parseCommandInput("/"), null);
  assert.equal(parseCommandInput("slash "), null);
});

test("the longest advertised name wins, and the remainder becomes arguments", () => {
  // "grill me" must not resolve to /grill with the argument "me".
  assert.deepEqual(resolveCommand("grill me", COMMANDS), { command: command("grill-me"), args: "" });
  assert.deepEqual(resolveCommand("grill", COMMANDS), { command: command("grill"), args: "" });
  assert.deepEqual(resolveCommand("research auth flow", COMMANDS), {
    command: command("research", { argumentHint: "<topic>" }),
    args: "auth flow",
  });
});

test("spoken spellings fold onto the advertised name", () => {
  assert.equal(resolveCommand("Grill Me!", COMMANDS)?.command.name, "grill-me");
  assert.equal(resolveCommand("grill_me", COMMANDS)?.command.name, "grill-me");
  // A separator we can never speak still has to be reachable by voice.
  assert.equal(resolveCommand("plugin deploy", COMMANDS)?.command.name, "plugin:deploy");
  assert.equal(resolveCommand("cost", COMMANDS)?.command.name, "usage");
  assert.equal(resolveCommand("nothing like this", COMMANDS), null);
});

test("suggestions rank prefix matches over dropped syllables, shortest first", () => {
  // /usage ranks in on its "cost" alias — aliases are matchable, not just display.
  assert.deepEqual(suggestCommands("c", COMMANDS).map((entry) => entry.name), ["clear", "usage", "compact", "context"]);
  assert.deepEqual(suggestCommands("gr", COMMANDS).map((entry) => entry.name), ["grill", "grill-me"]);
  // "cntxt" prefixes nothing but survives as a subsequence of "context".
  assert.deepEqual(suggestCommands("cntxt", COMMANDS).map((entry) => entry.name), ["context"]);
  assert.deepEqual(suggestCommands("zzzz", COMMANDS), []);
  assert.equal(suggestCommands("c", COMMANDS, 2).length, 2);
});

test("only context-destroying commands are treated as destructive", () => {
  assert.equal(isDestructive(command("clear")), true);
  assert.equal(isDestructive(command("compact")), true);
  assert.equal(isDestructive(command("research")), false);
  // A user skill is a prompt expansion; the worst it costs is a turn.
  assert.equal(isDestructive(command("grill-me")), false);
});

test("dispatch text is the provider's own slash form", () => {
  assert.equal(commandText({ command: command("compact"), args: "" }), "/compact");
  assert.equal(commandText({ command: command("research"), args: "auth flow" }), "/research auth flow");
  assert.equal(commandText({ command: command("plugin:deploy"), args: "" }), "/plugin:deploy");
});

test("answers arrive as a bare label or a JSON envelope", () => {
  assert.equal(parseAnswer("/compact"), "/compact");
  assert.equal(parseAnswer('"/compact"'), "/compact");
  assert.equal(parseAnswer('{"answer":"/compact"}'), "/compact");
  assert.equal(parseAnswer("not json {"), "not json {");
});
