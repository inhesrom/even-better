# Persistent owned sessions

Owned mode is the installed default: one even-better server and QR can create,
remember, and resume independent Claude, Codex, and Grok sessions.

## Start and workspace policy

```bash
cd /path/to/workspace
even-better
```

The canonical launch directory is the sole workspace root when no explicit
roots are configured. Repeatable CLI flags take precedence over the environment:

```bash
even-better --workspace-root /home/me/repos --workspace-root /home/me/work
```

`WORKSPACE_ROOTS` remains available and uses the platform path delimiter (`:`
on Unix, `;` on Windows). Explicit CLI or environment roots replace, rather than
extend, the launch-directory default. Every root must already exist and be an
accessible absolute directory.

Any existing descendant of a workspace root is an eligible directory. The
wizard offers four shortcuts: most-recently used eligible directories first,
then roots and their immediate children. Deeper descendants can be entered as
free text. even-better resolves filesystem real paths, never creates a requested
directory, and rejects nonexistent paths, ambiguous relative paths, and symlink
escapes.

## The setup wizard

`/api/sessions` lists remembered sessions plus exactly **one** wizard row.
Untouched it is titled **＋ Agent setup**. Opening it asks:

1. Which installed agent to use.
2. Which eligible directory to use.

Both questions come before any prompt exists — that is the point of the row.
After startup the session lands idle with a **Ready — say your prompt**
notification, and you speak the task into the live session. Its title is
**Provider · folder** until that first prompt arrives, then **Provider · folder ·
prompt excerpt**.

The directory question lists **every** eligible directory, most-recently-used
first, then by modification time, then by name. Dot-directories are excluded
unless previously used; either way any absolute or unambiguous root-relative path
can be spoken or typed instead. Set `WIZARD_DIRECTORY_LIMIT` (default `0` =
unlimited) if a long menu renders badly on the glasses.

Opening the row emits a `user_prompt` prime, then the question after
`SETUP_QUESTION_DELAY_MS` (default 500). This is not cosmetic: **a question sent
in the same tick as the stream opening is silently dropped by the app.** ADR 0005
records the measurement, including the four shapes that do not work. Raise the
delay if a slower phone misses the menu.

The unchanged stock app also renders its own **＋ New Session** row, whose
voice-first composer sends `POST /api/prompt` with a null or missing `sessionId`.
That prompt **adopts the wizard row** rather than adding a second one, retitling
it **Setting up · excerpt**, and is dispatched exactly once after startup —
nothing is discarded. A second prompt to an unfinished wizard returns `409`.

Only a setup that has begun starting a provider frees the slot, so exactly one
way in is offered at a time; while a provider boots its row reads **Starting
Agent · folder…** and a fresh **＋ Agent setup** appears beside it.

If provider startup fails, even-better keeps the transient session, the original
prompt, **and both answers**, then asks a single retry question — **Retry**,
**Change directory**, or **Change agent**. It never reopens the agent and
directory questions by itself: a provider that keeps failing would otherwise walk
the glasses through the whole wizard on every attempt, with no way out. Repeated
failures carry an `(attempt N)` count. Retrying setup does not duplicate the
prompt.

Because the ＋ New Session row is voice-first, a re-tap arrives as another
null-session prompt. That **restarts the wizard on the same public ID** and keeps
the phone's SSE stream; the newest prompt is the one retained. The wizard row is
catalog state: it is never written to disk and is minted fresh after a restart,
so an unfinished setup and its retained prompt do not survive one.

The phone's creation `provider` and `cwd` fields are compatibility inputs and
are ignored. The glasses wizard is authoritative, and the chosen agent provider
and canonical cwd remain fixed for that remembered session.

## Persistence and resume

Each completed owned session is stored under the platform state directory:

- Linux: `$XDG_STATE_HOME/even-better`, or `~/.local/state/even-better`
- macOS: `~/Library/Application Support/even-better`
- Windows: `%LOCALAPPDATA%\even-better`

Set `EVEN_BETTER_HOME` to override it. Metadata is replaced atomically and both
metadata and normalized `{role,text,timestamp}` JSONL history are user-only.
The persisted record contains the stable public ID, agent provider, canonical
cwd, provider-native resume ID, model, timestamps, and first prompt. Tool-event
bubbles are not copied into display history. An unfinished setup session and its
retained prompt are never written to disk.

At startup, remembered sessions whose cwd remains inside the active workspace
roots are listed most-recently used first. Opening one serves local display
history immediately and lazily attaches its original native context:

- Claude Agent SDK: `resume`
- Codex app-server: `thread/resume`
- Grok ACP: `session/load`, falling back to advertised `session/resume`

A resume failure keeps the row and history and emits an actionable notification.
Native transcripts remain the source of conversational context; even-better's
copy exists for phone display and catalog recovery.

## Slash commands

Providers that advertise a command list expose it to the glasses. Claude takes
its list from the Agent SDK handshake and refreshes it on `commands_changed`, so
built-ins, custom commands, and skills discovered mid-session are all reachable.
Grok takes its list from the ACP `available_commands_update` notification. Codex
advertises nothing — its app-server has no command surface — so Codex sessions
behave exactly as they did before, and every prompt goes through untouched.

Execution is passthrough: a resolved command is sent as `/name args`, which both
providers parse themselves. even-better never implements a command.

Because the composer is voice-first, both `/compact` and the spoken **"slash
compact"** are accepted. The phrase after the marker is resolved against the
live list, longest name first — so with both `/grill` and `/grill-me`
advertised, "slash grill me" runs `/grill-me` rather than `/grill` with the
argument "me". A single-word command still absorbs the rest as arguments, which
is what "slash research auth flow" needs. Spelling is folded before comparison,
so `plugin:deploy` is reachable as "slash plugin deploy".

What happens next depends on what the phrase resolved to:

| Outcome | Behaviour |
|---|---|
| One command, arguments satisfied | Runs immediately |
| One command that takes arguments, none given | Asks for them; any typed answer is accepted |
| `/clear`, `/compact`, `/rewind` | Asks to confirm — these discard context and cannot be undone |
| Several near-misses | Asks which, offering up to four |
| Nothing close enough | Sent to the provider as `/phrase`, which reports its own unknown command |

Ordinary prose is never intercepted: without the slash marker, "compact the
summary" is a prompt. Every command question carries **Cancel**, and
`POST /interrupt` also ends it — a command question opens a turn that has not
reached the provider, so nothing else could release the session.

## Providers and compatibility identity

Owned mode uses one stock-app Codex connection for every row. `/api/info`,
session descriptors, status events, and results therefore report
`provider:"codex"`, including sessions actually run by Claude or Grok. Owned
rows also include `agentProvider:"claude"|"codex"|"grok"`, and their titles name
the real provider.

Claude uses `@anthropic-ai/claude-agent-sdk` and the installed `claude`
executable. A new Claude session is *named* by even-better (the SDK's `sessionId`
option) rather than discovered, because the SDK reports a session id only once
the first turn begins — see the startup invariant in `AGENTS.md`. Codex uses the generated app-server schema verified for exact CLI
versions 0.142.5 and 0.145.0. Grok uses ACP with CLI 0.2.103 or newer. All CLIs
must already be authenticated; missing executables are omitted from the wizard.
Agent children do not inherit `BRIDGE_TOKEN`.

## Attached-process limit

`MAX_OWNED_SESSIONS` defaults to six and limits attached provider processes, not
remembered rows. When another process is needed, even-better detaches the
least-recently used idle process and retains its row for later resume. Busy and
awaiting-input sessions are never evicted; if all slots are protected, setup or
resume reports a process-cap error.

Setup questions and live permission/question prompts are re-emitted on SSE
reconnect. Shutdown interrupts active turns, closes attached processes with
bounded deadlines, and releases catalog leases without forgetting sessions.

## Session management

From the glasses, the **＋ Manage sessions** row appears in the list once at least
one session is remembered, directly after the wizard row. It asks which session
to delete — oldest first, labelled `<n> · Agent · folder` with its age and
first-prompt excerpt — then confirms with **Delete forever** / **Keep**.

The menu shows `MANAGE_SESSION_LIMIT` sessions at a time (default 4) and offers
**More sessions…** when others remain; ordinals continue across pages, so a
recent session is still reachable. This has no unlimited setting: an eleven-option
menu did not render at all on a physical phone — the row simply sat awaiting an
answer to a menu that was never drawn. After a delete the list has shifted, so
paging restarts at the oldest.

The row only removes sessions: prompting it returns `409`, and ＋ New
Session still lands on the wizard. A busy session is interrupted and its agent
stopped rather than refused, unlike the attached-process eviction below. Deleting
the last session leaves the row in place saying so, because dropping it would end
the phone's stream mid-use.

`DELETE /api/sessions/:id` reaches the same code path. The stock app never sends
it; it exists so `pnpm sim` (the `d` key in the picker) and the server tests can
drive deletion without hardware.

From a terminal:

```bash
even-better sessions
even-better sessions remove <public-id>
even-better sessions clear
```

Every route removes only even-better metadata/history. Native Claude, Codex, and
Grok transcripts are untouched. The CLI's removal is refused while a running
server leases a target row — stop the owning server first; the glasses row and
the HTTP verb release that lease themselves.

## Verification

```bash
corepack pnpm test:app-owned
CLAUDE_SMOKE=1 corepack pnpm smoke:claude
CODEX_SMOKE=1 corepack pnpm smoke:codex
```

The authenticated smokes remain skipped unless their gate is set.
