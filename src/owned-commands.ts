// Spoken-command matching. Every fragile heuristic for turning glasses input into
// a provider command lives here and nowhere else — the same containment rule
// `screen-timeline.ts` follows for screen artifacts. The bridge holds the state
// machine; this file is pure functions over the provider's own command list.
//
// The command list is always authoritative. Nothing here guesses at a name the
// provider did not advertise.

import type { AgentMode, OwnedCommand } from "./owned-agent.js";

/** Commands that discard conversation state and cannot be undone from the glasses.
 *  Deliberately tiny and explicit: a user skill is just a prompt expansion, so the
 *  worst it costs is a turn, while these cost the session's context. */
const DESTRUCTIVE = new Set(["clear", "compact", "rewind"]);

/** Fold spoken and typed spellings onto one key: "Grill Me!", "grill me",
 *  "grill-me" and "grill_me" all become "grill-me". Applied to both sides of every
 *  comparison, so provider names with separators we don't produce (Claude's
 *  `plugin:command`) still match what a person can say. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The spoken or typed remainder after the slash marker, with the marker removed.
 *  Splitting name from arguments is deliberately *not* done here: "slash research
 *  auth flow" is only decidable against the real command list, so that belongs to
 *  `resolveCommand`. */
export function parseCommandInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    const phrase = trimmed.slice(1).trim();
    return phrase || null;
  }
  // Voice input cannot produce punctuation, so "slash x" is the spoken spelling of
  // "/x". Requiring the marker keeps ordinary prose — including prose that merely
  // starts with a command's name — on the untouched prompt path.
  const spoken = /^slash[\s-]+(.+)$/i.exec(trimmed);
  return spoken ? spoken[1].trim() || null : null;
}

function names(command: OwnedCommand): string[] {
  return [command.name, ...(command.aliases ?? [])].map(normalize);
}

export interface ResolvedCommand {
  command: OwnedCommand;
  args: string;
}

/** Split `phrase` into a command and its arguments using the provider's list.
 *
 *  Longest name wins, so with both `grill` and `grill-me` advertised, "grill me"
 *  resolves to `grill-me` with no arguments rather than `grill` with "me". A
 *  single-word command still absorbs the rest as arguments, which is what
 *  "slash research auth flow" needs. */
export function resolveCommand(phrase: string, commands: OwnedCommand[]): ResolvedCommand | null {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  for (let take = tokens.length; take >= 1; take--) {
    const candidate = normalize(tokens.slice(0, take).join("-"));
    if (!candidate) continue;
    const command = commands.find((entry) => names(entry).includes(candidate));
    if (command) return { command, args: tokens.slice(take).join(" ") };
  }
  return null;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) at++;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/** Ranked near-misses for a phrase that resolved to nothing, for the picker menu.
 *  Prefix matches first (a truncated or mis-heard word), then subsequence matches
 *  (dropped syllables), shorter names first within each tier so the most likely
 *  target is the default option. */
export function suggestCommands(phrase: string, commands: OwnedCommand[], limit = 4): OwnedCommand[] {
  const needle = normalize(phrase.split(/\s+/)[0] ?? "");
  if (!needle) return [];
  const prefix: OwnedCommand[] = [];
  const loose: OwnedCommand[] = [];
  for (const command of commands) {
    const keys = names(command);
    if (keys.some((key) => key.startsWith(needle))) prefix.push(command);
    else if (keys.some((key) => isSubsequence(needle, key))) loose.push(command);
  }
  const byLength = (a: OwnedCommand, b: OwnedCommand): number =>
    a.name.length - b.name.length || a.name.localeCompare(b.name);
  return [...prefix.sort(byLength), ...loose.sort(byLength)].slice(0, Math.max(0, limit));
}

export function isDestructive(command: OwnedCommand): boolean {
  return names(command).some((name) => DESTRUCTIVE.has(name));
}

/** The wire text for a resolved command — what actually goes to the provider.
 *  Both Claude and Grok parse `/name args` out of an ordinary prompt, so dispatch
 *  is passthrough and no provider-specific execution path exists. */
export function commandText(resolved: ResolvedCommand): string {
  return resolved.args ? `/${resolved.command.name} ${resolved.args}` : `/${resolved.command.name}`;
}

/** Spoken and typed spellings of the three modes. Small on purpose: an unknown
 *  word is either a prompt we must not eat or a menu we can open, and both of
 *  those are safe outcomes — guessing is not. */
const MODE_WORDS: Record<string, AgentMode> = {
  plan: "plan",
  planning: "plan",
  normal: "normal",
  default: "normal",
  ask: "normal",
  auto: "auto",
  automatic: "auto",
};

/** Every way to ask for a mode, anchored to the WHOLE prompt.
 *
 *  Anchoring is the entire safety property. A prompt that merely contains these
 *  words — "change to auto mode detection in the parser" — matches nothing and
 *  reaches the agent untouched. On glasses a stolen prompt is invisible: you
 *  spoke, the agent never heard it, and something else happened instead. That is
 *  this project's worst failure class, so the cost of a phrasing we miss (the
 *  agent answers "I can't change my own mode") is deliberately the cheap side. */
const MODE_TEMPLATES: Array<{ pattern: RegExp; explicit: boolean }> = [
  // "mode", "/mode", "slash mode" — and the same with a verb in front.
  { pattern: /^(?:(?:change|switch|set)\s+(?:the\s+)?)?(?:slash[\s-]+|\/)?mode$/, explicit: true },
  // "/mode auto", "slash mode plan"
  { pattern: /^(?:slash[\s-]+|\/)mode\s+([a-z]+)$/, explicit: true },
  // "auto mode", "plan mode"
  { pattern: /^([a-z]+)\s+mode$/, explicit: true },
  // "change the mode to auto", "set mode to plan"
  { pattern: /^(?:change|switch|set|put)\s+(?:the\s+)?mode\s+(?:in)?to\s+(?:the\s+)?([a-z]+)$/, explicit: true },
  // "change to auto mode", "switch to plan mode", "go into normal mode"
  { pattern: /^(?:change|switch|go|set|put)\s+(?:me|us|it|the\s+session)?\s*(?:in)?to\s+(?:the\s+)?([a-z]+)\s+mode$/, explicit: true },
  // "switch to auto" — no literal "mode", so an unrecognized word is far more
  // likely to be a real prompt ("switch to the auth branch") than a typo'd mode.
  { pattern: /^(?:change|switch|go|set|put)\s+(?:me|us|it|the\s+session)?\s*(?:in)?to\s+(?:the\s+)?([a-z]+)$/, explicit: false },
];

export type ModeInput = { kind: "switch"; mode: AgentMode } | { kind: "menu" };

/** Match a spoken or typed prompt against the mode templates.
 *
 *  `null` means "this is an ordinary prompt" and is the default for everything
 *  the templates do not match exactly. A template that named the mode outright
 *  switches; one that asked for a mode without naming a recognizable one opens
 *  the picker instead of guessing. */
export function parseModeInput(text: string): ModeInput | null {
  const phrase = text
    .trim()
    .toLowerCase()
    // Voice input arrives punctuated ("Change to auto mode.") and the templates are
    // anchored, so trailing punctuation would defeat every one of them.
    .replace(/[.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase) return null;
  for (const { pattern, explicit } of MODE_TEMPLATES) {
    const match = pattern.exec(phrase);
    if (!match) continue;
    const word = match[1];
    if (word === undefined) return { kind: "menu" };
    const mode = MODE_WORDS[word];
    if (mode) return { kind: "switch", mode };
    // The prompt said "mode" but named something we do not know: ask rather than
    // guess, and rather than send a mode-switch request to the agent as prose.
    return explicit ? { kind: "menu" } : null;
  }
  return null;
}

/** The phone sends a question answer as either a bare label or a JSON envelope.
 *  Shared with the setup wizard, which met the same two shapes first. */
export function parseAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = Object.values(parsed as Record<string, unknown>)[0];
      if (typeof value === "string") return value;
    }
  } catch {
    // The phone commonly sends a plain option label.
  }
  return answer;
}
