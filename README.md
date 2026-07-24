# even-better

Use a coding-agent session from **Even Realities G2** glasses. even-better
speaks the same HTTP/SSE protocol as `@evenrealities/even-terminal`, so the
stock Even App connects by scanning a QR code. Its default owned source lets
each glasses session choose Claude, Codex, or Grok plus a working directory.
Explicit sources can instead mirror Claude Code or Codex already running in
[herdr](https://herdr.dev) or [cmux](https://github.com/manaflow-ai/cmux), or own
one standalone Grok ACP session.

```
┌── session source ─────┐      ┌── even-better ─────────┐      ┌── Even App ──┐
│ mux panes / owned CLIs│◄────►│ HTTP + SSE             │◄────►│  → G2 glasses │
│ Claude · Codex · Grok │ stdio│ even-terminal protocol │ WiFi │              │
└───────────────────────┘      └────────────────────────┘      └──────────────┘
```

> Unofficial project — not affiliated with or endorsed by Even Realities,
> Anthropic, OpenAI, herdr, or cmux. The wire protocol is an independent,
> interoperable implementation of what `@evenrealities/even-terminal` speaks.
> Owned sessions communicate with local agent CLIs through their supported SDK or
> app-server protocols; mux sessions observe local Claude Code and Codex session
> files. No code from those projects is included, and observed formats may change.

## Prerequisites

- **Node.js ≥ 18** and **pnpm**.
- For the mux source: **macOS** (primary target), with one terminal
  multiplexer running and at least one `claude` or `codex` agent live in a pane:
  - **[herdr](https://herdr.dev)**, or
  - **[cmux](https://github.com/manaflow-ai/cmux)** (agent hooks must be
    installed — Claude Code is automatic, Codex needs `cmux hooks codex install`).
- For the Grok source: Grok CLI **0.2.103 or newer**, authenticated by
  `XAI_API_KEY` or `grok login`. No multiplexer is used.
- For the default multi-session owned source: one or more authenticated CLIs
  installed: Claude Code, Codex CLI **0.142.5 or 0.145.0**, or Grok CLI
  **0.2.103 or newer**.
- **Even Realities G2** glasses paired with the **Even App** on your phone.
- For remote access: the matching CLI (`tailscale`, `cloudflared`, `ngrok`,
  `bore`, or the built-in `ssh` for pinggy) — see [Remote access](#remote-access-off-your-wi-fi).

## Quick start

```bash
corepack pnpm install
corepack pnpm build
npm install -g .

cd /path/to/workspace
even-better          # prints a QR code — scan it with the Even App
```

The launch directory is the default workspace root. The unchanged stock app
supplies the sole **＋ New Session** row. Submit its first voice prompt and
even-better opens the agent and directory wizard, retains that prompt during
setup, then sends it automatically after the selected provider session starts
and persists. Completed sessions remain in the list after server restarts and
resume their native provider context when reopened.

From a source checkout, `corepack pnpm start` provides the same default.

To mirror existing herdr/cmux panes instead, run:

```bash
even-better --source mux
```

If both multiplexers are running, pick one with `MUX=herdr` or `MUX=cmux`.

To launch one new Grok ACP session instead:

```bash
SOURCE=grok GROK_CWD="$PWD" even-better --source grok
```

Grok starts before the HTTP server. If its version, authentication, or working
directory is invalid, even-better exits with an actionable error and prints no
connection QR. See [docs/GROK.md](docs/GROK.md).

To replace the launch-directory default with multiple workspace roots:

```bash
even-better --workspace-root /home/me/repos --workspace-root /home/me/work
```

Choose Codex in the phone's connection screen. The provider and directory
fields sent by the app are compatibility values in this mode; the glasses
wizard makes both real selections. See [docs/OWNED.md](docs/OWNED.md).

## What it does

- **Mux stays mirror-only.** The explicit mux source keeps existing Claude/Codex
  panes and token usage unchanged.
- **Grok is explicit and owned.** `SOURCE=grok` launches one `grok agent stdio`
  child and closes it when even-better shuts down. It never mirrors Grok's TUI.
- **Owned sessions are durable.** The default source remembers each public ID,
  provider, directory, display history, and native resume ID. Provider and
  directory stay fixed for that session.
- **Structured output.** Mux mode reads Claude/Codex session transcripts as its
  source of truth; Grok mode consumes validated ACP frames. Neither coding-agent
  path screen-scrapes prose. (A fresh mux agent streams no content until its
  transcript exists.)
- **Interactive.** Permission prompts and questions become menus on the glasses
  you can answer. Prompts and interrupts drive the selected pane or owned Grok
  session.

For how this is built, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

Everything is optional — `even-better` works with no flags.

| Var | Default | Meaning |
| --- | --- | --- |
| `SOURCE` | `owned` in the CLI | Session source: per-session `owned` agents, existing `mux`, or one `grok` |
| `MUX` | auto | Multiplexer backend: `herdr` or `cmux`. Auto-detects; if both are present, prompts on a TTY (set this to choose) |
| `WORKSPACE_ROOTS` | launch cwd | Platform-delimited approved absolute roots; explicit values replace the cwd default |
| `EVEN_BETTER_HOME` | platform state directory | Override durable owned-session metadata/history storage |
| `MAX_OWNED_SESSIONS` | `6` | Maximum attached owned-agent processes; remembered sessions are not capped |
| `CLAUDE_BIN` | `claude` | Claude executable name or path; missing executables are omitted from the owned wizard |
| `CODEX_BIN` | `codex` | Codex executable name or path; missing executables are omitted from the owned wizard |
| `GROK_CWD` | – | Required with `SOURCE=grok`: accessible working directory for the new Grok session |
| `GROK_BIN` | `grok` | Grok executable name or path |
| `OWNED_STARTUP_TIMEOUT_MS` | `15000` | Per-agent startup deadline in owned mode |
| `OWNED_CANCEL_TIMEOUT_MS` | `5000` | Owned-session interruption deadline |
| `OWNED_SHUTDOWN_TIMEOUT_MS` | `2000` | Per-stage owned child shutdown deadline |
| `GROK_STARTUP_TIMEOUT_MS` | `15000` | Total deadline for version check, ACP initialization, authentication, and session creation |
| `GROK_CANCEL_TIMEOUT_MS` | `5000` | How long interruption may take before the owned Grok process is terminated |
| `GROK_SHUTDOWN_TIMEOUT_MS` | `2000` | Per-stage shutdown deadline before escalating from EOF to TERM to KILL |
| `PORT` | `auto` | HTTP port. Unset/`auto`/`0` asks the OS for a free port; set a number only when you need a fixed one |
| `BIND_HOST` | `auto` | Local bind/QR host: `auto`, `lan`, `local`, `tailscale`, or a literal IP. `PUBLIC_ACCESS` requires `auto` or loopback |
| `PUBLIC_ACCESS` | `none` | Public access provider: `none`, `tailscale-funnel`, `pinggy`, `bore`, `ngrok`, `cloudflared` |
| `PUBLIC_BASE_URL` | – | Existing external URL to put in the QR instead of starting `PUBLIC_ACCESS` (named tunnels, reverse proxies). Requires a fixed `PORT` |
| `BRIDGE_TOKEN` | ephemeral | Bearer token encoded into the QR. Unset means a fresh per-process token every launch |
| `LOG` | `normal` | Logging mode: `off`, `normal`, `debug`, or `trace` |
| `LOG_FILE` | `/tmp/even-better-<id>.events.log` | JSONL event log path |
| `QR` | `1` | Print a QR code. Set `0` to print only the URL |
| `STREAM_TICK_MS` | `140` | Milliseconds between text-reveal frames on the glasses. Larger = text types out slower (easier to read before it scrolls); smaller = faster |

The phone must be able to reach your machine over the network (same LAN,
Tailscale, etc.).

**Security.** The endpoint can drive a coding agent — i.e. run code on your
machine — guarded only by the bearer token. On a trusted home LAN the default QR
is fine; on an untrusted network use `BIND_HOST=tailscale`. See
[SECURITY.md](SECURITY.md).

## Remote access (off your Wi-Fi)

- **`BIND_HOST=tailscale` (recommended)** — private, WireGuard-encrypted, stable
  IP, no time limit, nothing exposed publicly. Best for regular use.
- **`PUBLIC_ACCESS=tailscale-funnel`** — public HTTPS at your stable `*.ts.net`
  name; the phone needs no client and SSE works. Requires Funnel enabled in the
  Tailscale admin console once.
- **`PUBLIC_ACCESS=pinggy`** — quick public access over the built-in `ssh`, zero
  install, supports SSE. Free tunnels rotate every 60 min. `bore`/`ngrok` also
  work (`ngrok` needs an authtoken).
- **Cloudflare** — the *quick* provider (`cloudflared`, trycloudflare.com) **does
  not support SSE**. Use a **named tunnel** pointed at the local URL instead
  (fixed `PORT` + `PUBLIC_BASE_URL=https://<your-hostname>`).

## Protocol surface

even-terminal-compatible endpoints under `/api`: `GET /events` (SSE) ·
`GET /sessions` · `GET /info` · `POST /prompt` · `POST /permission-response` ·
`POST /question-response` · `POST /interrupt` · `GET /status` · `GET /messages` ·
`GET /sessions/:id/history` · `GET /update-check`. Field-level reference in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Remembered-session commands

```bash
even-better sessions
even-better sessions remove <public-id>
even-better sessions clear
```

Removal forgets only even-better metadata and display history; the provider's
native transcript remains intact. A running server leases its remembered rows,
so stop that server before removing them.

## Caveats

- Cost isn't computed (token counts are reported; `costUsd` is always 0).
- The standalone Grok source is one fresh in-memory session per even-better
  launch. It does not resume persisted sessions or run concurrent sessions.
- Resume depends on the original provider's native transcript. A missing native
  session produces an actionable notification while preserving the remembered
  row and local display history.
- A claude/codex pane shows content only from its structured transcript — a fresh
  agent shows nothing until its session's jsonl exists (no lossy screen scraping).
- Permission menus are read from the screen; exotic prompts fall back to a
  "check your terminal" notification.
- In mux mode, even-better only mirrors and picks the focused pane. In standalone
  Grok mode, the single new session is the only session exposed to the glasses.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
