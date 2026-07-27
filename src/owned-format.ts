// Display strings shared by the owned catalog and the manage row. Separate from
// both so the manage row can import them without a cycle back through the
// catalog that constructs it.

import type { ProviderId } from "./session.js";

export function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok";
}

export function compactPrompt(prompt: string, limit = 56): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const points = [...normalized];
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : normalized;
}

/** Coarse "how stale is this row" for the manage menu, where the useful question
 *  is which session is oldest rather than exactly when it last ran. */
export function formatAge(fromMs: number, nowMs: number): string {
  if (!Number.isFinite(fromMs)) return "never used";
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
