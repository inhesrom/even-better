# ADR 0006: A manage-sessions row for deleting remembered sessions

- Status: Accepted
- Date: 2026-07-27
- Amended: 2026-07-29 (see Amendment)
- Builds on: ADR 0005

## Context

Owned mode remembers every completed session and never removes one. There is no
retention policy, no history truncation and no startup prune, and since ADR 0005
a wizard that finishes with no prompt persists a row too — so sessions now
accumulate from launch gestures as well as from work. Removing one meant a
terminal (`even-better sessions remove|clear`), which is also refused while a
running server leases the row.

Deletion below the UX layer already existed and was tested: `OwnedSessionStore`
has `remove()` and `clear()`. Only a trigger the glasses could reach was missing.

ADR 0004 had ruled that out. Its conclusion — a server-authored row cannot host a
menu — is what made prompt-triggered setup the only way in, and it would equally
have blocked any management surface. ADR 0005 re-measured and found the real
constraint is timing, not row provenance: a `user_question` in the same tick as
the stream opening is dropped, and the app renders it once the stream first
carries something turn-shaped. That reopened the design space this decision uses.

## Decision

A second synthetic catalog row, **＋ Manage sessions**, whose only job is
removing remembered sessions.

It appears once at least one session is remembered, so a fresh install shows only
the launcher, and it sorts directly after the wizard row. Its questions are
`owned-manage:<id>:pick` — remembered sessions oldest-first, labelled
`<n> · Agent · folder` with age and first-prompt excerpt, plus **Cancel** — and
`owned-manage:<id>:confirm` (**Delete forever** / **Keep**).

Two device constraints were measured on a physical phone after the first build,
and both had the same silent signature — the row rendered, the menu did not, and
the session sat awaiting an answer to something that was never drawn:

| Attempted | Result |
|---|---|
| Row titled 🗑 Manage sessions | glyph did not render |
| Delete menu with 10 sessions + Cancel | menu did not render |
| Row titled ＋ Manage sessions | renders |
| Delete menu paged to 2 | renders, answerable, delete completes |

So the row uses ＋ (U+FF0B), the one non-ASCII character the app already uses
itself, and the menu pages at `MANAGE_SESSION_LIMIT` (default 4) with a **More
sessions…** option. Ordinals continue across pages so recent sessions stay
reachable, and a delete resets to the first page because the list has shifted.

It reaches the glasses through the same prime and deferral the wizard uses,
extracted to `owned-row-question.ts` so the two rows cannot drift.

`catalog.forget(id)` is the single removal path: dispose the session, drop it from
the catalog map, then `store.remove()`. `DELETE /api/sessions/:id` calls the same
method. The stock app never sends it; it exists so the sim and the server tests
drive the real path without hardware.

A busy session is interrupted and its agent stopped rather than refused —
deliberately unlike LRU eviction, which never takes a busy row, because the user
asking to delete it has said what they want.

The row is never torn down once created. Deleting the last session leaves it in
place with a **No sessions to delete** notification.

Rejected: a `/forget` slash command. `owned-commands.ts` is strictly
provider-passthrough — commands are enumerated, never invented — Codex advertises
none at all, and a command runs only from inside a session, so it could not clean
up when nothing is open.

## Consequences

- The app shows three non-session rows once anything is remembered: its own
  ＋ New Session, ＋ Agent setup, and ＋ Manage sessions.
- Removal from the glasses works while the server runs, which the CLI's
  lease refusal never allowed.
- Native Claude, Codex and Grok transcripts are still untouched; only
  even-better's metadata and display history are removed.
- Deleting ends that session's SSE stream, so a phone watching the row it just
  deleted sees the stream close and the row gone on the next `/api/sessions` poll.
- Every persisting path is now gated on `disposed`, because `store.save()`,
  `appendHistory()` and `acquireLease()` all recreate the session directory.
- A question's option count is now known to be bounded, which nothing before this
  had established. The exact ceiling is not: 11 fails and 4 works, and where the
  line falls between them is unmeasured. `MANAGE_SESSION_LIMIT` exists to move it
  without a rebuild.
- `WIZARD_DIRECTORY_LIMIT`'s `0` (unlimited) predates that measurement and is now
  suspect. ADR 0005 widened the directory question from four options to every
  eligible directory on the reasoning that four was too few; a workspace with
  enough directories may have silently traded one problem for the other. Not
  changed here — it deserves its own measurement rather than a guess.
- ADR 0005's failure signature recurs: the app rejects nothing and reports
  nothing, so any menu that does not render looks from the server exactly like one
  that does. Only a physical phone distinguishes them.

## Amendment (2026-07-29)

Two things above were wrong in use, both reported from the glasses.

**Cancel had no exit.** The original build re-emitted the picker on Cancel — "the
row has nowhere else to go, and a menu-less row is indistinguishable from a broken
one." On the device that reads as a menu that cannot be dismissed: answering
Cancel puts the same list straight back. The mistake was conflating *keep the row*
with *keep a menu on it*.

Cancel now terminalizes the turn the prime opened, the way Cancel does on every
bridge menu (`finishTurn`): ack, `result`, `status: idle`, `pendingWire` cleared
(`closeRowTurn`, in `owned-row-question.ts` beside the prime and the deferral for
the same no-drift reason). `state` follows from the pending menu — `awaiting` only
when one exists — which also fixes the empty-list row reading `awaiting` forever,
and an answer to a row with no menu returns `409` instead of landing in the
unrecognized-answer branch and re-arming it.

Going quiet was not enough on its own: it left the user parked on a row with
nothing on it and no way back into the picker. What Cancel has to mean is *leave
the row*, and the protocol has no navigation event — the app owns the visual.
Ending the row's SSE stream is the only lever, so `catalog.retire(row)` does that
and drops the row, and a replacement with a **new id** takes its place. The new id
matters as much as the stream end: it is what forces the app to open a fresh
stream, and with it the prime and the menu, instead of holding a dead one. It also
makes the loop unreachable — the cancelled id no longer resolves, so an
EventSource reconnecting to it gets nothing rather than a re-primed picker.

The replacement must exist on the *first* `list()` after Cancel — that is the poll
the app makes as it backs out of the row, and a row that is not on it reads as
gone. `ensureManager` mints synchronously and satisfies that for free;
`ensurePickup` does not, because its discovery probe is fire-and-forget, so
`retire()` mints the pickup replacement itself. (Measured on hardware: the manage
row came back, the pickup row did not. The unit fake hid it by resolving its
candidate scan inline — real discovery is filesystem I/O, and the fake now defers
by a macrotask so the gap is visible to the suite.)

That supersedes "the row is never torn down once created" (Decision, above). The
reasoning behind that line survives intact: an `res.end()` the user did not ask
for is still hostile, which is why the empty-list row still says **No sessions to
delete** instead of vanishing mid-use, and why the turn is closed before the
stream is. Cancel is the one case where the user asked to leave.

**The pick label was too short.** `<n> · Agent · folder` named a directory, not a
session; the distinguishing first-prompt excerpt sat in `description`, where the
app does not surface it usefully. The label now carries it —
`<n> · Agent · folder · excerpt`, mirroring the pickup row (ADR 0007), whose
longer labels were already device-proven — and `description` carries the age
alone. Option *count* remains the measured constraint; label length is not one.

The pickup row had the identical Cancel branch, by inheritance, and got the same
fix.
