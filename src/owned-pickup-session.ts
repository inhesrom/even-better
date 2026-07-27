// The ＋ Pick up session row: a synthetic catalog row whose only job is adopting
// coding-agent sessions the user already started in a terminal. It is the third
// application of ADR 0005's finding that a server-authored row can host a menu,
// and it shares that mechanism with the wizard and the manage row through
// `owned-row-question.ts` rather than reimplementing it.
//
// Nothing here reads provider filesystems (that is `owned-discovery.ts` via the
// catalog) and nothing here spawns a process; `catalog.adopt()` owns every side
// effect, and the provider child starts only when the adopted row is opened.

import path from "node:path";
import { parseAnswer } from "./owned-commands.js";
import type { ExternalSessionCandidate } from "./owned-discovery.js";
import { compactPrompt, formatAge, providerLabel } from "./owned-format.js";
import { deferRowQuestion, primeRow } from "./owned-row-question.js";
import type { OwnedSessionCatalog } from "./owned-session-catalog.js";
import {
  SessionControlError,
  type LiveSession,
  type SessionDescriptor,
  type SessionHistoryEntry,
  type SessionState,
} from "./session.js";
import { dropSession, emit } from "./sse.js";

/** Same glyph constraint as the manage row: only ＋ (U+FF0B) and `·` are known to
 *  render in a row title. */
const ROW_TITLE = "＋ Pick up session";
const PRIME_TEXT = "Pick up session";
const CANCEL = "Cancel";
const CONFIRM = "Pick up here";
const KEEP = "Keep in terminal";
const MORE = "More sessions…";

type PickupStep = "pick" | "confirm";

interface Candidate {
  /** What catalog.adopt() consumes, exactly as discovery listed it. */
  candidate: ExternalSessionCandidate;
  /** Exactly what the menu showed. Answers carry no correlation id, so the label
   *  is the only key back to the session — and the ordinal prefix is what makes
   *  it unique when two sessions share a provider and a directory. */
  label: string;
  /** The string the confirm question names the session by: provider, folder, and
   *  excerpt when one exists — the short label alone cannot tell two sessions in
   *  one directory apart. */
  title: string;
  /** Freshness plus an excerpt. "Active <age>" is the row's substitute for
   *  process-liveness detection: whether the terminal copy is still open is
   *  unknowable portably, so the menu shows recency and the confirm step warns. */
  description: string;
}

export class OwnedPickupSession implements LiveSession {
  readonly provider = "codex" as const;
  readonly cwd = "";
  private step: PickupStep = "pick";
  private displayed: Candidate[] = [];
  private target: Candidate | null = null;
  /** Index into the newest-first list that the current page starts at. Paging
   *  keeps every candidate reachable under a page cap without a long menu. */
  private pageStart = 0;
  private pendingWire: object | null = null;
  private adopting = false;
  private questionTimer: NodeJS.Timeout | null = null;
  private readonly createdAt = new Date().toISOString();

  constructor(
    readonly id: string,
    private readonly catalog: OwnedSessionCatalog,
  ) {}

  get state(): SessionState {
    // Never `awaiting` while an adopt is running: there is no menu to answer, and
    // respondQuestion() would reject the answer anyway.
    return this.adopting ? "busy" : "awaiting";
  }

  describe(): Promise<SessionDescriptor> {
    return Promise.resolve({
      id: this.id,
      title: ROW_TITLE,
      timestamp: this.createdAt,
      cwd: "",
      provider: "codex",
      status: this.state,
      model: "Unknown",
    });
  }

  prompt(): Promise<void> {
    return Promise.reject(
      new SessionControlError("This row only picks up existing sessions. Open ＋ Agent setup to start a new one.", 409),
    );
  }

  respondPermission(): Promise<void> {
    return Promise.reject(new SessionControlError("No permission request is pending.", 409));
  }

  async respondQuestion(answer: string): Promise<void> {
    if (this.adopting) throw new SessionControlError("A session is being picked up.", 409);
    const value = parseAnswer(answer).trim();
    switch (this.step) {
      case "pick":
        await this.answerPick(value);
        return;
      case "confirm":
        await this.answerConfirm(value);
        return;
      default: {
        const unreachable: never = this.step;
        throw new Error(`Unhandled pickup step: ${String(unreachable)}`);
      }
    }
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  async onConnect(): Promise<void> {
    if (this.adopting) {
      this.notify("Picking up…", "The selected session is still being picked up.");
      return;
    }
    // Without this the app drops the question replayPending() is about to
    // schedule — see owned-row-question.ts.
    primeRow(this.id, PRIME_TEXT);
    switch (this.step) {
      case "pick":
        // Awaited so pendingWire exists before index.ts calls replayPending().
        await this.askPick(false);
        return;
      case "confirm":
        this.askConfirm(false);
        return;
      default: {
        const unreachable: never = this.step;
        throw new Error(`Unhandled pickup step: ${String(unreachable)}`);
      }
    }
  }

  history(): Promise<SessionHistoryEntry[]> {
    return Promise.resolve([]);
  }

  replayPending(): void {
    if (this.adopting || !this.pendingWire) return;
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = deferRowQuestion(
      this.id,
      this.pendingWire,
      this.catalog.config.setupQuestionDelayMs,
      () => !this.adopting,
    );
  }

  dispose(): void {
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = null;
    dropSession(this.id);
  }

  private async answerPick(value: string): Promise<void> {
    if (!value || value.toLowerCase() === CANCEL.toLowerCase()) {
      this.ack(CANCEL);
      this.notify("Nothing picked up", "Every session stays in its terminal.");
      // Re-armed rather than left blank: this row has nowhere else to go, and a
      // menu-less row is indistinguishable from a broken one.
      this.pageStart = 0;
      await this.askPick(true);
      return;
    }
    if (value.toLowerCase() === MORE.toLowerCase()) {
      this.ack(MORE);
      this.pageStart += this.catalog.config.pickupSessionLimit;
      await this.askPick(true);
      return;
    }
    const chosen = this.displayed.find((candidate) => candidate.label.toLowerCase() === value.toLowerCase());
    if (!chosen) {
      this.notify("Choose a session", "Select one of the sessions shown below, or Cancel.");
      await this.askPick(true);
      return;
    }
    this.ack(chosen.label);
    this.target = chosen;
    this.askConfirm(true);
  }

  private async answerConfirm(value: string): Promise<void> {
    const target = this.target;
    const choice = value.toLowerCase();
    if (!target || choice === KEEP.toLowerCase()) {
      this.ack(KEEP);
      await this.askPick(true);
      return;
    }
    if (choice !== CONFIRM.toLowerCase()) {
      // Anything unrecognized keeps the session in its terminal — including the
      // literal "skip" that index.ts substitutes for an empty answer body.
      this.notify("Choose an option", `Confirm with "${CONFIRM}", or keep it in the terminal.`);
      this.askConfirm(true);
      return;
    }
    this.ack(CONFIRM);
    await this.beginAdopt(target);
  }

  /** Fire-and-forget for the same reason `beginLaunch` and `beginForget` are:
   *  adopt() re-reads the native transcript, and awaiting it here would hold the
   *  phone's question-response POST open for the whole time. Every outcome is
   *  reported over SSE instead. */
  private beginAdopt(target: Candidate): Promise<void> {
    this.adopting = true;
    this.target = null;
    return this.catalog
      .adopt(target.candidate)
      .then(({ title }) => {
        this.notify(
          "Session picked up",
          `${title} is in your session list now. Open it and speak to continue where the terminal left off.`,
        );
      })
      .catch((error: unknown) => {
        this.notify("Could not pick up session", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.adopting = false;
        // The list shifted under the page, and a fresh adoptable() now excludes
        // the adopted session — the re-ask reflects the shrunk list, and the
        // last adopt lands on the "No sessions to pick up" state.
        this.pageStart = 0;
        void this.askPick(true);
      });
  }

  private async askPick(send: boolean): Promise<void> {
    this.step = "pick";
    this.target = null;
    const now = Date.now();
    // Always fresh: every ask is a user-visible moment, and the session the user
    // just left in a terminal has to be on it.
    const all = await this.catalog.adoptable(true);
    const size = this.catalog.config.pickupSessionLimit;
    // A page that ran off the end (everything on it was adopted) wraps rather
    // than showing an empty menu.
    if (this.pageStart >= all.length) this.pageStart = 0;
    const page = all.slice(this.pageStart, this.pageStart + size);
    this.displayed = page.map((candidate, index) => {
      const folder = path.basename(candidate.cwd || "/");
      const excerpt = candidate.title ? compactPrompt(candidate.title, 40) : "";
      return {
        candidate,
        label: `${this.pageStart + index + 1} · ${providerLabel(candidate.agentProvider)} · ${folder}`,
        title: `${providerLabel(candidate.agentProvider)} · ${folder}${excerpt ? ` · ${excerpt}` : ""}`,
        description: `Active ${formatAge(candidate.lastModifiedMs, now)}${excerpt ? ` · ${excerpt}` : ""}`,
      };
    });
    const remaining = all.length - (this.pageStart + page.length);
    if (!this.displayed.length) {
      // A menu with only Cancel on it is worse than saying so plainly. The row
      // stays — dropping it would end the phone's stream mid-use.
      this.pendingWire = null;
      this.notify(
        "No sessions to pick up",
        "No recent Claude or Codex terminal session is inside WORKSPACE_ROOTS and not already here. Start one with the claude or codex CLI, or adjust WORKSPACE_ROOTS.",
      );
      return;
    }
    const wire = {
      type: "user_question",
      questions: [{
        question: remaining > 0
          ? `Which session should be picked up? Newest first, ${remaining} more after these.`
          : "Which session should be picked up? It resumes here on the glasses; close the terminal copy first.",
        header: "Pick up",
        options: [
          ...this.displayed.map((candidate) => ({
            label: candidate.label,
            description: candidate.description,
          })),
          ...(remaining > 0
            ? [{ label: MORE, description: `Show the next ${Math.min(remaining, size)} of ${remaining}.` }]
            : []),
          { label: CANCEL, description: "Leave every session in its terminal." },
        ],
      }],
      toolUseId: `owned-pickup:${this.id}:pick`,
    };
    this.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  private askConfirm(send: boolean): void {
    this.step = "confirm";
    const target = this.target;
    if (!target) {
      void this.askPick(send);
      return;
    }
    const wire = {
      type: "user_question",
      questions: [{
        question: `Pick up ${target.title}?`,
        header: "Confirm",
        options: [
          {
            label: CONFIRM,
            description: "Close the terminal copy first — both would write to the same session. It resumes here and can be handed back later.",
          },
          { label: KEEP, description: "Go back without picking it up." },
        ],
      }],
      toolUseId: `owned-pickup:${this.id}:confirm`,
    };
    this.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  /** The row answers its own questions — there is no agent to echo the choice
   *  back, and the app leaves the menu open until something does. */
  private ack(answer: string): void {
    emit(this.id, { type: "question_answer", answers: { answer } });
  }

  private notify(title: string, message: string): void {
    emit(this.id, { type: "notification", title, message });
  }
}
