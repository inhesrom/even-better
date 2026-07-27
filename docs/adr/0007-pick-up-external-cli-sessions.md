# ADR 0007: Picking up coding-agent sessions started in a terminal

- Status: Accepted
- Date: 2026-07-27
- Builds on: ADR 0005, ADR 0006

## Context

A user who already has `claude` or `codex` running in a plain terminal on the
machine may want to hand that conversation to the glasses. Nothing offered a way
in: owned mode only starts fresh sessions from the wizard, and `SOURCE=mux` only
mirrors panes inside herdr or cmux. A bare terminal — no multiplexer — was
unreachable.

The machinery for continuing an existing native session already existed. Every
owned adapter branches on `OwnedAgent.start(sink, nativeSessionId?)`: Claude
passes `resume:` to the Agent SDK, Codex calls `thread/resume {threadId}`, and
nothing downstream of `catalog.attach()` knows where the id came from. Owned
children also run against the user's real `~/.claude` and `~/.codex` (there is no
config-dir isolation anywhere in owned code), so a terminal session and an owned
session are already one population on disk. What was missing was discovery — the
repo's only transcript locators (`findSessionFile`, `findCodexSessionFile`) take
an exact id — and a surface on the glasses to choose one.

## Decision

**Takeover-by-resume through a third synthetic row, ＋ Pick up session.**

Adopting synthesizes an ordinary `RememberedSessionMetadata` whose
`nativeSessionId` is the external session's id, saves it, and leases the row. No
process starts at adopt time; the first open or prompt walks the existing
lazy-attach path and resumes the native session, and a failed resume reuses the
existing "could not resume" notification. Claude resumes the same session id in
place (no `forkSession`), so the user can hand back later with
`claude --resume <id>`.

Discovery (`owned-discovery.ts`) is read-only and spawns nothing:

- **Claude**: the Agent SDK's `listSessions({ includeProgrammatic: false })` —
  the SDK's own "terminal `/resume` parity" filter, which also excludes
  even-better's SDK-driven children.
- **Codex**: the rollout tree pruned by its `YYYY/MM/DD` layout — only the
  recency window's date directories are read — taking `session_id` and `cwd`
  from each file's line-0 `session_meta` (the filename's trailing UUID is the
  fallback; codex derives `session_id` from the same `conversation_id` the
  filename carries, verified against `codex-rs/rollout/src/recorder.rs`).

Candidates are filtered by a 7-day recency window (a constant: older sessions
are better reached from a terminal, and the window is what keeps the codex scan
to a handful of directories), by `WORKSPACE_ROOTS` eligibility (the CLI-recorded
cwd is as untrusted as a phone-supplied one and is canonicalized through
`workspaces.resolve` again at adopt time), and by **dedupe against every
remembered `nativeSessionId`** — which also excludes every session even-better
itself created. A provider whose binary is missing contributes no candidates:
adopting a session that can never attach is a trap.

The row appears once at least one adoptable candidate exists, via a
fire-and-forget probe so `list()` never waits on a filesystem scan, and is never
torn down afterward (ADR 0006's hazard: dropping a row ends the phone's live
stream). Its questions are `owned-pickup:<id>:pick` — candidates newest-first
(the manage row is oldest-first because its question is "which is stale"; this
one's is "which did I just leave"), labelled `<n> · Agent · folder` with an
`Active <age>` freshness line, paged at `PICKUP_SESSION_LIMIT` (default 4) —
and `owned-pickup:<id>:confirm` (**Pick up here** / **Keep in terminal**). It
reaches the glasses through the same prime and deferral as the other synthetic
rows (`owned-row-question.ts`).

Rejected alternatives:

- **Attaching to the live terminal process.** There is no portable way to inject
  input into a foreign terminal; a resume into a new child is the only takeover
  primitive the providers offer.
- **A read-only live mirror.** The transcript-content path works paneless, but
  nothing drives busy/idle, permission menus are screen-only (there is no screen
  we control), and prompting needs a pane. Full-fidelity mirroring of terminals
  is `docs/HOOK-MIGRATION.md` Phase 2 — a multiplexer-backend roadmap, not this
  feature.
- **A third `SOURCE` mode.** The retired `SOURCE=grok` set the precedent
  (`docs/ARCHITECTURE.md`): a second copy does not earn a seam. This lives
  inside `OwnedSessionCatalog`.
- **`codex app-server thread/list` for discovery.** It exists on 0.145 and is
  the authoritative registry — `sourceKinds: ["cli"]`, cursor paging, previews —
  but it costs a process spawn per scan. Noted as the future upgrade path; the
  rollout scan does the job in-band today.
- **Process-liveness scanning** (pgrep, `/proc`). Platform-dependent and
  misattributable. The menu shows freshness instead, and the confirm step always
  warns to close the terminal copy first.

## Consequences

- The app can show four non-session rows: ＋ New Session (stock), ＋ Agent setup,
  ＋ Manage sessions, ＋ Pick up session. The pickup row only appears when there
  is something to pick up.
- **Two writers on one native session are documented, not guarded.** The store
  lease only excludes a second even-better server; nothing stops the terminal
  copy from continuing to write the session the glasses resumed. The always-on
  confirm warning is the mitigation, and same-id resume is also what makes
  hand-back work. Sessions driven by a multiplexer or another tool look like
  ordinary CLI candidates and carry the same caveat.
- An adopted session is an ordinary remembered row: the manage row deletes it
  (releasing the native session for adoption again), the attach cap and LRU
  eviction gate its process, and provider/cwd stay immutable after adoption.
- Discovery failures quiet the row rather than surfacing through `list()`; a
  candidate list that empties after the row exists leaves it in place with a
  **No sessions to pick up** notification naming `WORKSPACE_ROOTS`.
- `session_meta` line 0 of codex rollouts is now consumed (`session_id`, `cwd`)
  — a new forward-compat surface tracked in `docs/SESSIONS.md`. Its `originator`
  and `source` fields are deliberately unused: the remembered-id dedupe already
  excludes even-better's own threads, and 0.145's serialized values for
  app-server threads are unverified.
- The pick and confirm menus inherit ADR 0006's silent-failure signature; both
  were kept inside the measured-good envelope (≤6 options, short descriptions)
  and deserve a physical-phone render check before release.
