import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnedCommand } from "../src/owned-agent.js";
import {
  commandText,
  isDestructive,
  parseAnswer,
  parseCommandInput,
  parseModeInput,
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

test("a named mode switches, spoken the ways people actually say it", () => {
  const mode = (text: string): string | undefined => {
    const parsed = parseModeInput(text);
    return parsed?.kind === "switch" ? parsed.mode : undefined;
  };
  assert.equal(mode("change to auto mode"), "auto");
  assert.equal(mode("switch to plan mode"), "plan");
  assert.equal(mode("go to normal mode"), "normal");
  assert.equal(mode("plan mode"), "plan");
  assert.equal(mode("auto mode"), "auto");
  assert.equal(mode("/mode plan"), "plan");
  assert.equal(mode("slash mode auto"), "auto");
  assert.equal(mode("set the mode to plan"), "plan");
  assert.equal(mode("switch to auto"), "auto");
  // Voice arrives capitalized and punctuated, and the templates are anchored.
  assert.equal(mode("Change to Auto mode."), "auto");
  assert.equal(mode("  switch to plan mode!  "), "plan");
  // Synonyms fold onto the three neutral modes.
  assert.equal(mode("default mode"), "normal");
  assert.equal(mode("planning mode"), "plan");
  assert.equal(mode("automatic mode"), "auto");
});

test("an unnamed or unrecognized mode opens the picker instead of guessing", () => {
  assert.deepEqual(parseModeInput("mode"), { kind: "menu" });
  assert.deepEqual(parseModeInput("/mode"), { kind: "menu" });
  assert.deepEqual(parseModeInput("slash mode"), { kind: "menu" });
  assert.deepEqual(parseModeInput("change the mode"), { kind: "menu" });
  // Said "mode" outright but named something we do not know: ask, never guess.
  assert.deepEqual(parseModeInput("switch to yolo mode"), { kind: "menu" });
  assert.deepEqual(parseModeInput("/mode ludicrous"), { kind: "menu" });
});

// The one place this feature could eat a real prompt. On glasses a stolen prompt is
// invisible: you spoke, the agent never heard it, and the mode changed instead.
test("a prompt that merely mentions modes is never stolen", () => {
  for (const prompt of [
    "change to auto mode detection in the parser",
    "switch to plan mode when the user asks, and document it",
    "the auto mode flag is broken",
    "explain plan mode",
    "what mode am i in",
    "add a normal mode to the state machine",
    // No literal "mode", so an unknown target is far likelier to be a real prompt.
    "switch to the auth branch",
    "change to typescript",
    "go to line 40",
    "",
    "compact the context",
  ]) {
    assert.equal(parseModeInput(prompt), null, `stole the prompt: ${JSON.stringify(prompt)}`);
  }
});

test("answers arrive as a bare label or a JSON envelope", () => {
  assert.equal(parseAnswer("/compact"), "/compact");
  assert.equal(parseAnswer('"/compact"'), "/compact");
  assert.equal(parseAnswer('{"answer":"/compact"}'), "/compact");
  assert.equal(parseAnswer("not json {"), "not json {");
});
