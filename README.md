# even-better

Use a coding-agent session from **Even Realities G2** glasses. even-better
speaks the same HTTP/SSE protocol as `@evenrealities/even-terminal`, so the
stock Even App connects by scanning a QR code. Its default `mux` source mirrors
Claude Code or Codex already running in [herdr](https://herdr.dev) or
[cmux](https://github.com/manaflow-ai/cmux). Its opt-in `grok` source instead
owns one complete [ACP](https://agentclientprotocol.com/) session launched with
`grok agent stdio` in a working directory you choose.

```
┌── session source ─────┐      ┌── even-better ─────────┐      ┌── Even App ──┐
│ claude / codex panes  │◄────►│ HTTP + SSE             │◄────►│  → G2 glasses │
│ or Grok ACP child     │ stdio│ even-terminal protocol │ WiFi │              │
└───────────────────────┘      └────────────────────────┘      └──────────────┘
```

> Unofficial project — not affiliated with or endorsed by Even Realities,
> Anthropic, OpenAI, herdr, or cmux. The wire protocol is an independent,
> interoperable implementation of what `@evenrealities/even-terminal` speaks;
> agent output is read from the local session files Claude Code and Codex write on
> your own machine. No code from those projects is included, and their formats are
> used as observed and may change.

## Prerequisites

- **Node.js ≥ 18** and **pnpm**.
- For the default mux source: **macOS** (primary target), with one terminal
  multiplexer running and at least one `claude` or `codex` agent live in a pane:
  - **[herdr](https://herdr.dev)**, or
  - **[cmux](https://github.com/manaflow-ai/cmux)** (agent hooks must be
    installed — Claude Code is automatic, Codex needs `cmux hooks codex install`).
- For the Grok source: Grok CLI **0.2.103 or newer**, authenticated by
  `XAI_API_KEY` or `grok login`. No multiplexer is used.
- **Even Realities G2** glasses paired with the **Even App** on your phone.
- For remote access: the matching CLI (`tailscale`, `cloudflared`, `ngrok`,
  `bore`, or the built-in `ssh` for pinggy) — see [Remote access](#remote-access-off-your-wi-fi).

## Quick start

```bash
pnpm install
pnpm start          # prints a QR code — scan it with the Even App
```

That's it — the glasses now show your live agent. Prompts you send from the
glasses are typed into the pane; the agent's replies stream back.

If both herdr and cmux are running, pick one with `MUX=herdr` or `MUX=cmux`.

To launch one new Grok ACP session instead:

```bash
SOURCE=grok GROK_CWD="$PWD" pnpm start
```

Grok starts before the HTTP server. If its version, authentication, or working
directory is invalid, even-better exits with an actionable error and prints no
connection QR. See [docs/GROK.md](docs/GROK.md).

## What it does

- **Mux stays mirror-only.** The default source keeps the existing Claude/Codex
  panes and token usage unchanged.
- **Grok is explicit and owned.** `SOURCE=grok` launches one `grok agent stdio`
  child and closes it when even-better shuts down. It never mirrors Grok's TUI.
- **Structured output.** Mux mode reads Claude/Codex session transcripts as its
  source of truth; Grok mode consumes validated ACP frames. Neither coding-agent
  path screen-scrapes prose. (A fresh mux agent streams no content until its
  transcript exists.)
- **Interactive.** Permission prompts and questions become menus on the glasses
  you can answer. Prompts and interrupts drive the selected pane or owned Grok
  session.

For how this is built, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

Everything is optional — `pnpm start` works with no flags.

| Var | Default | Meaning |
| --- | --- | --- |
| `SOURCE` | `mux` | Session source: existing `mux` mirroring or one owned `grok` ACP session |
| `MUX` | auto | Multiplexer backend: `herdr` or `cmux`. Auto-detects; if both are present, prompts on a TTY (set this to choose) |
| `GROK_CWD` | – | Required with `SOURCE=grok`: accessible working directory for the new Grok session |
| `GROK_BIN` | `grok` | Grok executable name or path |
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

## Caveats

- Cost isn't computed (token counts are reported; `costUsd` is always 0).
- The Grok source is one fresh in-memory session per even-better launch. It does
  not resume persisted sessions or run concurrent Grok sessions.
- A claude/codex pane shows content only from its structured transcript — a fresh
  agent shows nothing until its session's jsonl exists (no lossy screen scraping).
- Permission menus are read from the screen; exotic prompts fall back to a
  "check your terminal" notification.
- In mux mode, even-better only mirrors and picks the focused pane. In Grok mode,
  the single new session is the only session exposed to the glasses.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
