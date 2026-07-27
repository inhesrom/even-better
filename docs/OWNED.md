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

## Stock-launcher prompt-triggered setup

`/api/sessions` lists remembered sessions only. The unchanged stock app renders
the sole **＋ New Session** row and opens its voice-first composer when selected;
selection itself makes no server request. Submitting that first prompt sends
`POST /api/prompt` with a null or missing `sessionId`. even-better creates a
transient setup session, returns `202` with its stable public ID, and retains the
prompt while its SSE stream asks:

1. Which installed agent to use.
2. Which eligible directory to use.

While setup is unfinished the transient row is titled **Setting up agent
session…**. A second prompt targeting that ID returns `409`. Completing setup
starts the selected provider session, persists its native resume ID and first
prompt, appends the prompt to display history, turns the same public ID into a
remembered session, and dispatches the retained prompt exactly once. Its title
is immediately **Provider · folder · prompt excerpt**.

If provider startup fails, even-better keeps the transient session, the original
prompt, **and both answers**, then asks a single retry question — **Retry**,
**Change directory**, or **Change agent**. It never reopens the agent and
directory questions by itself: a provider that keeps failing would otherwise walk
the glasses through the whole wizard on every attempt, with no way out. Repeated
failures carry an `(attempt N)` count. Retrying setup does not duplicate the
prompt.

Because the ＋ row is voice-first, a re-tap arrives as another null-session
prompt. That **restarts the wizard on the same public ID** and keeps the phone's
SSE stream; the newest prompt is the one retained. Transient setup is
intentionally not durable across a server restart.

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

```bash
even-better sessions
even-better sessions remove <public-id>
even-better sessions clear
```

These commands remove only even-better metadata/history. Native Claude, Codex,
and Grok transcripts are untouched. Removal is refused while a running server
leases a target row; stop the owning server first.

## Verification

```bash
corepack pnpm test:app-owned
CLAUDE_SMOKE=1 corepack pnpm smoke:claude
CODEX_SMOKE=1 corepack pnpm smoke:codex
```

The authenticated smokes remain skipped unless their gate is set.
