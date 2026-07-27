# ADR 0006: A manage-sessions row for deleting remembered sessions

- Status: Accepted
- Date: 2026-07-27
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
