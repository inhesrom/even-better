# Grok ACP source

The Grok source is an explicit alternative to the default Claude/Codex
multiplexer mirror. It launches one owned Grok CLI child, creates one fresh ACP
session, and exposes that session through the existing Even-app HTTP/SSE
protocol.

## Launch

Requirements:

- Grok CLI 0.2.103 or newer on `PATH` (or set `GROK_BIN`)
- an existing `grok login`, or `XAI_API_KEY` in even-better's environment
- an accessible working directory

```bash
pnpm install
SOURCE=grok GROK_CWD=/absolute/path/to/project pnpm start
```

Do not set `MUX` with `SOURCE=grok`. The default remains `SOURCE=mux`, so an
ordinary `pnpm start` preserves the existing Claude/Codex behavior.

Startup is fail-closed. even-better checks the CLI version, launches
`grok --no-auto-update agent stdio`, negotiates ACP v1, chooses headless API-key
or cached-token authentication, and creates a session with `GROK_CWD`. The HTTP
server starts only after all of those steps succeed.

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

The session ID printed by `/api/sessions` starts with `grok:`. It is an
even-better public ID; Grok's private ACP session, prompt, tool, and permission
IDs never cross the HTTP boundary.

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

| Variable | Default | Contract |
| --- | --- | --- |
| `GROK_CWD` | required | Canonical accessible session working directory |
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
pnpm test:app-grok
GROK_SMOKE=1 pnpm smoke:grok  # makes one real model request
```

For a real local smoke test, launch with `QR=0`, call `/api/sessions`, submit a
minimal no-tool prompt, and confirm the event log contains `user_prompt`,
`text_delta`, `result`, then `status` with `state:"idle"`. A glasses test uses
the same launch command without `QR=0`; scan the printed URL in the Even App.

## Deliberate v1 limits

- one fresh session; no concurrency or persisted-session resume
- no Grok TUI mirroring
- no direct xAI API path and no other ACP agents
- no Even app or wire-protocol changes
- no automatic fallback from Grok to a Claude/Codex multiplexer
