# Grok

Grok runs as an owned agent: even-better launches one Grok CLI child, creates or
resumes one ACP session, and exposes it through the Even-app HTTP/SSE protocol
like any other provider.

> **`SOURCE=grok` has been retired.** It was a standalone source with its own
> catalog and bridge (`grok-session-catalog.ts`, `grok-bridge.ts`), but that
> bridge was a fork of the common `OwnedSessionBridge` — 81 of its lines were
> byte-identical to it — wrapping the *same* `GrokAcpProcess` that owned mode
> already drives. Owned mode supersedes it with no loss of capability, and adds
> persistence, resume, and multiple concurrent sessions. `SOURCE=grok` and
> `--source grok` now fail with a message pointing here.

## Launch

Requirements:

- Grok CLI 0.2.103 or newer on `PATH` (or set `GROK_BIN`)
- an existing `grok login`, or `XAI_API_KEY` in even-better's environment
- a working directory inside an approved workspace root

```bash
even-better                      # owned mode is the default
even-better --workspace-root /absolute/path/to/project
```

Then start a session from the app's **＋ New Session** row: the first prompt
opens the setup wizard, which asks for an agent (choose **Grok**) and a
directory. The chosen directory must be an eligible descendant of a workspace
root — unlike the old `GROK_CWD`, it is validated against that policy rather
than taken from the environment.

Startup is fail-closed. even-better checks the CLI version, launches
`grok --no-auto-update agent stdio`, negotiates ACP v1, chooses headless API-key
or cached-token authentication, and creates a session in the chosen directory.
The session only becomes remembered once all of those steps succeed.

## Session behavior

The source supports one complete live glasses session:

- prompts and streamed assistant prose
- keyed tool start/update/end events
- plan progress and token/result reporting
- the exact permission choices offered by Grok, including allow-always when present
- Grok's `_x.ai/ask_user_question` form, including sequential and multi-select answers
- ACP `session/cancel` interruption
- one terminal result followed by idle status for every accepted prompt

Unsupported image, audio, embedded-resource, or terminal-content payloads are
not forwarded to the glasses. The user receives one notification for the turn;
ordinary text and tool metadata continue normally.

The session ID printed by `/api/sessions` starts with `owned:`. It is an
even-better public ID; Grok's private ACP session, prompt, tool, and permission
IDs never cross the HTTP boundary. As in all owned sessions the wire `provider`
is `codex` (the stock app's compatibility identity) and the real agent appears
as `agentProvider: "grok"` and in the session title.

## Process and secrets

Grok inherits the launch environment so `XAI_API_KEY` and standard Grok config
continue to work. `BRIDGE_TOKEN` is deliberately removed from the child
environment. ACP traffic is not written to the event log. User-facing failures
contain phase and recovery guidance rather than raw stderr or credentials.

On shutdown, even-better cancels an active turn, uses `session/close` only when
the agent advertises it, closes stdin, and escalates only its owned process
group from TERM to KILL if deadlines expire. An unexpected child exit makes the
session unavailable until even-better is restarted.

## Configuration

The working directory comes from the setup wizard and the workspace-root policy
(`WORKSPACE_ROOTS` / `--workspace-root`), not from an environment variable;
`GROK_CWD` was part of the retired standalone source and is no longer read.

| Variable | Default | Contract |
| --- | --- | --- |
| `GROK_BIN` | `grok` | Executable name or executable file path |
| `GROK_STARTUP_TIMEOUT_MS` | `15000` | 1000–120000 ms total startup deadline |
| `GROK_CANCEL_TIMEOUT_MS` | `5000` | 250–60000 ms cancellation deadline |
| `GROK_SHUTDOWN_TIMEOUT_MS` | `2000` | 250–30000 ms for each shutdown escalation stage |

## Verification

The repository's test suite includes a deterministic ACP agent and covers
startup, authentication failure, prompt/prose/tool streaming, allow and deny
permission responses, questions, interruption, subprocess failure, clean
shutdown, and the full HTTP protocol. Run:

```bash
pnpm check
pnpm test
pnpm test:grok                # Grok ACP over the owned bridge
GROK_SMOKE=1 pnpm smoke:grok  # makes one real model request
```

`pnpm sim --fake` drives the whole wizard against the deterministic ACP fixture
without reaching a model — pick **Grok** when it asks for an agent.

For a real local smoke test, launch with `QR=0`, drive the wizard via
`POST /api/prompt` + `/api/question-response`, and confirm the event log contains
`user_prompt`, `text_delta`, `result`, then `status` with `state:"idle"`. A
glasses test uses the same launch without `QR=0`; scan the printed URL.

## Deliberate v1 limits

- one fresh session; no concurrency or persisted-session resume
- no Grok TUI mirroring
- no direct xAI API path and no other ACP agents
- no Even app or wire-protocol changes
- no automatic fallback from Grok to a Claude/Codex multiplexer
