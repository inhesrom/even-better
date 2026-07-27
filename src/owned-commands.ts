// Spoken-command matching. Every fragile heuristic for turning glasses input into
// a provider command lives here and nowhere else — the same containment rule
// `screen-timeline.ts` follows for screen artifacts. The bridge holds the state
// machine; this file is pure functions over the provider's own command list.
//
// The command list is always authoritative. Nothing here guesses at a name the
// provider did not advertise.

import type { OwnedCommand } from "./owned-agent.js";

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
