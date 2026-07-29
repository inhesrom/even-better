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
import { closeRowTurn, deferRowQuestion, primeRow } from "./owned-row-question.js";
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
  /** Exactly what the menu showed, excerpt included — the label is what
   *  identifies a session at a glance, and two sessions in one directory are
   *  otherwise indistinguishable. Answers carry no correlation id, so the label
   *  is also the only key back to the session; the ordinal prefix keeps it
   *  unique and speakable. */
  label: string;
  /** The string the confirm question names the session by: provider, folder,
   *  and excerpt when one exists. */
  title: string;
  /** Freshness plus the git branch. "Active <age>" is the row's substitute for
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
    // respondQuestion() would reject the answer anyway. Awaiting is derived from
    // the pending menu rather than assumed: a cancelled or empty picker has none,
    // and a row that reads needs-input forever is the bug this fixed.
    if (this.adopting) return "busy";
    return this.pendingWire ? "awaiting" : "idle";
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
    // A cancelled row has no menu, and answering one that is gone would land in
    // the unrecognized-answer branch and put the picker back — the loop Cancel
    // exists to leave.
    if (!this.pendingWire) throw new SessionControlError("No question is pending.", 409);
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
    // Fenced on the wire that was pending when the timer was armed: an answer
    // landing inside the delay replaces or clears it, and firing the captured
    // one would put a stale menu on a row that has moved on.
    const wire = this.pendingWire;
    this.questionTimer = deferRowQuestion(
      this.id,
      wire,
      this.catalog.config.setupQuestionDelayMs,
      () => !this.adopting && this.pendingWire === wire,
    );
  }

  dispose(): void {
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = null;
    dropSession(this.id);
  }

  /** The success half of dispose(): the public id lives on as the adopted
   *  session, so the SSE stream must NOT be dropped — dispose()'s dropSession()
   *  would res.end() the stream the phone is watching. Only the row object
   *  dies: clear the deferred-question timer and the pending wire so nothing
   *  can put a pick menu on the adopted session's stream. */
  handOff(): void {
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = null;
    this.pendingWire = null;
  }

  private async answerPick(value: string): Promise<void> {
    if (!value || value.toLowerCase() === CANCEL.toLowerCase()) {
      this.ack(CANCEL);
      // Cancel leaves the row, it does not re-arm it: re-emitting the picker was
      // a menu with no way out, and going merely quiet left the user on a dead
      // row. Close the turn, then hand the row to retire() — that ends the SSE
      // stream (the only lever the protocol gives us to put the app back on the
      // session list) and mints a replacement with a new id on the next poll.
      this.pendingWire = null;
      this.pageStart = 0;
      closeRowTurn(this.id, "Cancelled — nothing picked up.");
      this.catalog.retire(this);
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

  /** The confirm POST resolves when the adopt settles (bounded transcript
   *  reads, no spawn — the warm-up is fire-and-forget inside the catalog), so
   *  success and failure both report before the phone re-polls. */
  private beginAdopt(target: Candidate): Promise<void> {
    this.adopting = true;
    this.target = null;
    return this.catalog
      .adopt(target.candidate, this)
      .then(() => {
        // Handed off: this public id is the remembered session now and get()
        // routes past this object. The catalog emitted the promote frames and
        // began the warm-up; nothing here may touch the wire again. `adopting`
        // stays true so the state getter and the deferred-question live()
        // guard keep any stray reference inert.
      })
      .catch((error: unknown) => {
        this.notify("Could not pick up session", error instanceof Error ? error.message : String(error));
        this.adopting = false;
        // The list may have shifted; re-ask from the top. A candidate list
        // that emptied lands on the "No sessions to pick up" state.
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
      const excerpt = candidate.title ? compactPrompt(candidate.title, 32) : "";
      return {
        candidate,
        label: `${this.pageStart + index + 1} · ${providerLabel(candidate.agentProvider)} · ${folder}${excerpt ? ` · ${excerpt}` : ""}`,
        title: `${providerLabel(candidate.agentProvider)} · ${folder}${excerpt ? ` · ${excerpt}` : ""}`,
        description: `Active ${formatAge(candidate.lastModifiedMs, now)}${candidate.branch ? ` · ${candidate.branch}` : ""}`,
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
      // Only on a live stream (the candidate list emptied under an open menu):
      // nothing else clears the indicator until a reconnect. On connect, index.ts
      // snapshots the derived state right after this and would duplicate it.
      if (send) emit(this.id, { type: "status", state: "idle", sessionId: this.id, provider: "codex" });
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
