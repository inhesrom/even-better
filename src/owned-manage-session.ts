// The ＋ Manage sessions row: a synthetic catalog row whose only job is removing
// remembered sessions. It is the second application of ADR 0005's finding that a
// server-authored row can host a menu, and it shares that mechanism with the
// setup wizard through `owned-row-question.ts` rather than reimplementing it.
//
// Nothing here is persisted. The row has no record, no lease, no bridge and no
// native session; `catalog.forget()` owns every side effect on disk.

import path from "node:path";
import { parseAnswer } from "./owned-commands.js";
import { compactPrompt, formatAge, providerLabel } from "./owned-format.js";
import type { OwnedSessionCatalog } from "./owned-session-catalog.js";
import { closeRowTurn, deferRowQuestion, primeRow } from "./owned-row-question.js";
import {
  SessionControlError,
  type LiveSession,
  type SessionDescriptor,
  type SessionHistoryEntry,
  type SessionState,
} from "./session.js";
import { dropSession, emit } from "./sse.js";

/** No emoji: 🗑 did not render on a physical phone, and only ＋ (U+FF0B, which the
 *  app uses itself) is known to. `·` is safe — remembered row titles use it. */
const ROW_TITLE = "＋ Manage sessions";
const PRIME_TEXT = "Manage sessions";
const CANCEL = "Cancel";
const CONFIRM = "Delete forever";
const KEEP = "Keep";
const MORE = "More sessions…";

type ManageStep = "pick" | "confirm";

interface Candidate {
  id: string;
  /** Exactly what the menu showed, excerpt included — the label is what
   *  identifies a session at a glance, and two sessions in one directory are
   *  otherwise indistinguishable. Answers carry no correlation id, so the label
   *  is also the only key back to the session; the ordinal prefix keeps it
   *  unique and speakable. */
  label: string;
  /** The catalog's own row title, for the confirm question — the string the user
   *  recognizes from the session list. */
  title: string;
  /** Age alone: which session is oldest is the question the delete menu asks,
   *  and the excerpt that answers "which one is this" is in the label. */
  description: string;
}

export class OwnedManageSession implements LiveSession {
  readonly provider = "codex" as const;
  readonly cwd = "";
  private step: ManageStep = "pick";
  private displayed: Candidate[] = [];
  private target: Candidate | null = null;
  /** Index into the oldest-first list that the current page starts at. Paging keeps
   *  recent sessions reachable under a page cap without a long menu. */
  private pageStart = 0;
  private pendingWire: object | null = null;
  private deleting = false;
  private questionTimer: NodeJS.Timeout | null = null;
  private readonly createdAt = new Date().toISOString();

  constructor(
    readonly id: string,
    private readonly catalog: OwnedSessionCatalog,
  ) {}

  get state(): SessionState {
    // Never `awaiting` while a delete is running: there is no menu to answer, and
    // respondQuestion() would reject the answer anyway. Awaiting is derived from
    // the pending menu rather than assumed: a cancelled or empty picker has none,
    // and a row that reads needs-input forever is the bug this fixed.
    if (this.deleting) return "busy";
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
      new SessionControlError("This row only removes sessions. Open ＋ Agent setup to start one.", 409),
    );
  }

  respondPermission(): Promise<void> {
    return Promise.reject(new SessionControlError("No permission request is pending.", 409));
  }

  async respondQuestion(answer: string): Promise<void> {
    if (this.deleting) throw new SessionControlError("A session is being deleted.", 409);
    // A cancelled row has no menu, and answering one that is gone would land in
    // the unrecognized-answer branch and put the picker back — the loop Cancel
    // exists to leave.
    if (!this.pendingWire) throw new SessionControlError("No question is pending.", 409);
    const value = parseAnswer(answer).trim();
    switch (this.step) {
      case "pick":
        this.answerPick(value);
        return;
      case "confirm":
        await this.answerConfirm(value);
        return;
      default: {
        const unreachable: never = this.step;
        throw new Error(`Unhandled manage step: ${String(unreachable)}`);
      }
    }
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  onConnect(): Promise<void> {
    if (this.deleting) {
      this.notify("Deleting…", "The selected session is still being removed.");
      return Promise.resolve();
    }
    // Without this the app drops the question replayPending() is about to
    // schedule — see owned-row-question.ts.
    primeRow(this.id, PRIME_TEXT);
    switch (this.step) {
      case "pick":
        this.askPick(false);
        return Promise.resolve();
      case "confirm":
        this.askConfirm(false);
        return Promise.resolve();
      default: {
        const unreachable: never = this.step;
        throw new Error(`Unhandled manage step: ${String(unreachable)}`);
      }
    }
  }

  history(): Promise<SessionHistoryEntry[]> {
    return Promise.resolve([]);
  }

  replayPending(): void {
    if (this.deleting || !this.pendingWire) return;
    clearTimeout(this.questionTimer ?? undefined);
    // Fenced on the wire that was pending when the timer was armed: an answer
    // landing inside the delay replaces or clears it, and firing the captured
    // one would put a stale menu on a row that has moved on.
    const wire = this.pendingWire;
    this.questionTimer = deferRowQuestion(
      this.id,
      wire,
      this.catalog.config.setupQuestionDelayMs,
      () => !this.deleting && this.pendingWire === wire,
    );
  }

  dispose(): void {
    clearTimeout(this.questionTimer ?? undefined);
    this.questionTimer = null;
    dropSession(this.id);
  }

  private answerPick(value: string): void {
    if (!value || value.toLowerCase() === CANCEL.toLowerCase()) {
      this.ack(CANCEL);
      // Cancel leaves the row, it does not re-arm it: re-emitting the picker was
      // a menu with no way out, and going merely quiet left the user on a dead
      // row. Close the turn, then hand the row to retire() — that ends the SSE
      // stream (the only lever the protocol gives us to put the app back on the
      // session list) and mints a replacement with a new id on the next poll.
      this.pendingWire = null;
      this.pageStart = 0;
      closeRowTurn(this.id, "Cancelled — nothing deleted.");
      this.catalog.retire(this);
      return;
    }
    if (value.toLowerCase() === MORE.toLowerCase()) {
      this.ack(MORE);
      this.pageStart += this.catalog.config.manageSessionLimit;
      this.askPick(true);
      return;
    }
    const chosen = this.displayed.find((candidate) => candidate.label.toLowerCase() === value.toLowerCase());
    if (!chosen) {
      this.notify("Choose a session", "Select one of the sessions shown below, or Cancel.");
      this.askPick(true);
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
      this.askPick(true);
      return;
    }
    if (choice !== CONFIRM.toLowerCase()) {
      // Anything unrecognized keeps the session — including the literal "skip"
      // that index.ts substitutes for an empty answer body.
      this.notify("Choose an option", `Confirm with "${CONFIRM}", or keep the session.`);
      this.askConfirm(true);
      return;
    }
    this.ack(CONFIRM);
    await this.beginForget(target);
  }

  /** Fire-and-forget for the same reason `beginLaunch` is: `forget()` awaits a
   *  bounded child teardown, and awaiting it here would hold the phone's
   *  question-response POST open for the whole time. Every outcome is reported
   *  over SSE instead. */
  private beginForget(target: Candidate): Promise<void> {
    this.deleting = true;
    this.target = null;
    return this.catalog
      .forget(target.id)
      .then(() => {
        this.notify("Session deleted", `${target.title} was forgotten. Its agent transcript was kept.`);
      })
      .catch((error: unknown) => {
        this.notify("Could not delete session", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.deleting = false;
        // The list shifted under the page; start again from the oldest.
        this.pageStart = 0;
        this.askPick(true);
      });
  }

  private askPick(send: boolean): void {
    this.step = "pick";
    this.target = null;
    const now = Date.now();
    const all = this.catalog.deletable();
    const size = this.catalog.config.manageSessionLimit;
    // A page that ran off the end (everything on it was deleted) wraps rather than
    // showing an empty menu.
    if (this.pageStart >= all.length) this.pageStart = 0;
    const page = all.slice(this.pageStart, this.pageStart + size);
    this.displayed = page.map((session, index) => {
      const folder = path.basename(session.cwd || "/");
      const excerpt = session.firstPrompt ? compactPrompt(session.firstPrompt, 32) : "";
      return {
        id: session.id,
        label: `${this.pageStart + index + 1} · ${providerLabel(session.agentProvider!)} · ${folder}${excerpt ? ` · ${excerpt}` : ""}`,
        title: session.rowTitle,
        description: formatAge(session.lastUsedMs, now),
      };
    });
    const remaining = all.length - (this.pageStart + page.length);
    if (!this.displayed.length) {
      // A menu with only Cancel on it is worse than saying so plainly. The row
      // stays — dropping it would end the phone's stream mid-use.
      this.pendingWire = null;
      this.notify("No sessions to delete", "Nothing is remembered yet. Open ＋ Agent setup to start one.");
      // Only on a live stream (the last delete just finished): nothing else
      // clears the indicator until a reconnect. On connect, index.ts snapshots
      // the derived state right after this and would duplicate it.
      if (send) emit(this.id, { type: "status", state: "idle", sessionId: this.id, provider: "codex" });
      return;
    }
    const wire = {
      type: "user_question",
      questions: [{
        question: remaining > 0
          ? `Which session should be deleted? Oldest first, ${remaining} more after these.`
          : "Which session should be deleted? Its history here is removed; the agent's own transcript is kept.",
        header: "Delete",
        options: [
          ...this.displayed.map((candidate) => ({
            label: candidate.label,
            description: candidate.description,
          })),
          ...(remaining > 0
            ? [{ label: MORE, description: `Show the next ${Math.min(remaining, size)} of ${remaining}.` }]
            : []),
          { label: CANCEL, description: "Keep every session." },
        ],
      }],
      toolUseId: `owned-manage:${this.id}:pick`,
    };
    this.pendingWire = wire;
    if (send) emit(this.id, wire);
  }

  private askConfirm(send: boolean): void {
    this.step = "confirm";
    const target = this.target;
    if (!target) {
      this.askPick(send);
      return;
    }
    const wire = {
      type: "user_question",
      questions: [{
        question: `Delete ${target.title}?`,
        header: "Confirm",
        options: [
          {
            label: CONFIRM,
            description: "Removes even-better's metadata and history. The agent's own transcript is untouched.",
          },
          { label: KEEP, description: "Go back without deleting." },
        ],
      }],
      toolUseId: `owned-manage:${this.id}:confirm`,
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
