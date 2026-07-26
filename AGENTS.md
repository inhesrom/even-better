# even-better

> This file is the single source of agent instructions ([agents.md](https://agents.md)
> standard — read by Codex, Cursor, Zed, etc.). `CLAUDE.md` is a symlink to it for
> Claude Code. Edit here only; never create a separate per-tool copy.

Use a coding-agent session from Even Realities G2 glasses. A local HTTP/SSE
server speaks the `@evenrealities/even-terminal` protocol so the stock Even app
connects by QR scan. The installed CLI defaults to `SOURCE=owned`: setup-first,
persistent phone sessions that choose Claude, Codex, or Grok plus an eligible
directory. Explicit `SOURCE=mux` mirrors Claude/Codex already running in herdr
or cmux. Explicit `SOURCE=grok` owns one fresh `grok agent stdio` ACP session in
`GROK_CWD`.

## Architecture

Producer → spine → consumer. Read `docs/ARCHITECTURE.md` before any structural
change — it is the source of truth and explains *why* the seams are where they are.

```
Multiplexer(herdr) × Agent(claude)  →  AgentEvent stream  →  Sink (render + SSE)
        the Source (produces events)        the spine          the consumer
```

- **`spine.ts`** — `AgentEvent` (`prompt|say|tool|toolResult`) + `Timeline`. The
  provider-neutral vocabulary; nothing downstream of it knows jsonl vs screen.
- **`transcript.ts`** — `TranscriptTimeline`: parses Claude's session jsonl.
  Structured, lossless, **no heuristics**.
- **`screen-timeline.ts`** — `ScreenTimeline`: TUI-scraping content source for
  agents with **no transcript parser** (claude/codex are transcript-only — see the
  invariant below). **All** fragile heuristics (diff, volatile-line filter, dedup,
  echo suppression) live here and nowhere else.
- **`render.ts`** — pure `string→string` glasses transforms (table reflow, box
  strip). Applied before emit.
- **`multiplexer.ts`** — the `Multiplexer` seam (pane I/O) + normalized
  `PaneStatus`. `index.ts` picks one backend at boot (`MUX` env, else auto) and
  everything reads it via `getMux()`. Status is normalized here so the bridge's
  turn machine is backend-agnostic; `explain()` is an optional capability.
- **`herdr.ts`** — the herdr socket client (RPC + subscribe) + `HerdrMultiplexer`.
- **`cmux.ts`** — `CmuxMultiplexer`: drives the `cmux` CLI. Session ids come from
  cmux's agent *hooks* (`~/.cmuxterm/<agent>-hook-sessions.json` + `surface
  resume get`); status from one shared `cmux events` stream routed per surface.
  No classifier ⇒ no `explain()`; blocked menus fall back to screen parsing.
- **`output-stream.ts`** — `OutputStream`: paces text out a few code points per
  tick (smooth typing) and interleaves whole events (tool_start) in order.
- **`bridge.ts`** — `PaneBridge`: the core. Turn lifecycle, token accounting,
  the permission/question interaction state machine.
- **`session.ts` / `*-session-catalog.ts`** — source-neutral route boundary.
  Mux delegates to `PaneBridge`; Grok exposes exactly one live session; owned
  mode lists durable, lazily attached sessions only. The stock **＋ New
  Session** row is the sole launcher; its null-session first prompt creates a
  transient setup session, survives the wizard, and runs after provider startup.
- **`owned-agent.ts` / `owned-session-bridge.ts`** — provider-neutral contract
  and common owned bridge. Provider adapters own only their native protocol;
  the common bridge owns public IDs, pacing, interactions, and wire events.
- **`owned-workspaces.ts` / `owned-config.ts` / `owned-session-store.ts`** —
  realpath-enforced directory policy, MRU choices, atomic private persistence,
  leases, executable discovery, limits, and child configuration.
- **`grok-acp-process.ts` / `grok-acp-normalize.ts` / `grok-bridge.ts`** — owned
  Grok child + ACP SDK, exhaustive wire normalization, and even-terminal event
  mapping. Keep ACP/private IDs on this producer side.
- **`expose.ts`** — public tunnel used by the tunnel `ACCESS` modes (`tailscale-funnel`/`funnel`|`pinggy`|`bore`|`ngrok`|`cloudflared`): spawns the tunnel CLI, scrapes its URL, prints the one QR. `funnel` (Tailscale) is SSE-verified + auto-tears-down on exit; Cloudflare *quick* tunnels break SSE — noted inline. `index.ts`'s `resolveAccess()` picks the provider and calls `startExpose(name, …)`.
- **`sse.ts` / `index.ts`** — even-terminal SSE fan-out + HTTP server.
- **`parse.ts`** — screen menu parsing (`parseMenu`/`classifyMenu`).

## Commands

- `pnpm start` — run the server (prints QR). No build step; runs via `tsx`.
- `pnpm check` — `tsc --noEmit`. Must pass before every commit.
- `pnpm test` — runs every `scripts/test-*.ts` suite via the `node:test` runner.
  Run one suite after touching its module with
  `npx tsx --test scripts/test-transcript.ts` (or `test-render`, `test-diff-unit`,
  `test-widgets`, `test-menu`, etc.) — pure-function unit tests.
- End-to-end: `tools/app-sim.ts` records what a connected app receives;
  `tools/analyze-sim.py` scores a recording. See "Verification" below.
- `pnpm sim` — interactive protocol client standing in for the glasses, not for
  the agents: it launches a real server via `src/cli.ts` (so real providers,
  roots and remembered sessions) and attaches, rendering the four consumption
  semantics and answering permission/question menus. `pnpm sim <port> <token>`
  attaches to a server already running — use that when one is, since two servers
  contend for the session store's leases. `pnpm sim --fake grok|owned` swaps in
  `scripts/fixtures` and reaches no model; that mode offers Codex and Grok only,
  because Claude has no spawnable fixture (the SDK launches the real CLI).
- `pnpm test:app-grok` — deterministic full-server Grok protocol test.
- `pnpm test:app-owned` — deterministic full-server owned-session wizard test.
- `GROK_SMOKE=1 pnpm smoke:grok` — gated one-prompt real-Grok smoke; never run
  in ordinary tests or without accepting model usage.
- `CLAUDE_SMOKE=1 pnpm smoke:claude` / `CODEX_SMOKE=1 pnpm smoke:codex` — gated
  one-prompt real owned-agent smokes; never run without accepting model usage.

## Critical invariants (each cost a debugging round — do not relearn them)

- **Never call `server.*` on the herdr socket** (`server.reload_config` /
  `server.stop` kill herdr). `herdr.ts` enforces a `SAFE_METHODS` allowlist — keep
  new methods inside it.
- **Multi-key sequences must be SEPARATE presses with a gap.** Bundling
  `["Down","Enter"]` into one `send_input` races the TUI highlight and picks the
  wrong option. See `pressAndVerify` in `bridge.ts`.
- **Claude menus don't respond to number keys.** Enter confirms the highlighted
  option (default = option 1), arrows move it, Escape cancels. Digits are only
  fallbacks. This is the measured grammar in `respondPermission`.
- **Transcript-only content for claude/codex.** They mirror the jsonl
  (`TranscriptTimeline`) and nothing else: before the transcript resolves the
  bridge shows no content (the poll keeps retrying the upgrade), rather than
  degrading to the `ScreenTimeline` scrape — that only ever mirrored boot/TUI
  noise in the pre-transcript window. `ScreenTimeline` as a *content* source is
  now reserved for agents with no transcript parser. The screen is still read for
  the **interaction layer** (permission menus, codex approval detection) — that is
  a separate direct read, not this content path. Dedup/filtering remain **screen
  artifacts** confined to `ScreenTimeline`, never in the core.
- **Text is append-only on the app side.** Once a `text_delta` is sent it cannot
  be edited. This is *why* we buffer whole prose blocks from the jsonl and
  `renderForGlasses` them before sending — we can fix a table only because we hold
  the complete block first.
- **Tools use the `tool_start`→`tool_end` bubble (keyed by `toolId`).** The app
  labels and colors tool events; work with that. `tool_start` carries `name`,
  `summary` (readable command), and `detail.input` (full params); `tool_end`
  adds `detail.output`. Both go through `streamEvent()` to stay in order.
  `pendingTools` correlates the pair and describes the tool for permissions.
- **Output is streamed, not chunked.** Text types out a few code points per
  `STREAM_TICK_MS` (`streamText()`, adaptive rate so long answers stay bounded)
  so it reveals smoothly with no artificial line breaks; `tool_start` events
  interleave in order (`streamEvent()`). `result`/idle wait for `drainStream()`.
  Widgets (status/stats/task_progress) bypass the queue.
- **Interaction timeouts do not auto-deny.** A blocked pane stays `awaiting`
  until the user answers or the menu clears — no SDK forces a decision on us.
- **Grok is default-off and process-owned.** Never inspect Grok/auth in mux mode,
  never fall back between sources, never expose ACP IDs/frames, and never signal
  a process other than the validated child/group created by `GrokAcpProcess`.
  Shutdown remains cancel → optional advertised close → EOF → TERM → KILL.
- **Owned Claude startup must never wait for `system/init`.** The Agent SDK emits
  that message only once a turn begins, and the first prompt is not sent until
  `start()` resolves — waiting on it deadlocks until the startup timeout, every
  time. `initializationResult()` is the startup signal; it carries no session id
  or active model, so a fresh session is *named* by us (`sessionId`, a UUID) and
  the model is late-bound from `system/init` on turn one. Fakes that announce
  `system/init` eagerly hide this — `test-claude-owned-agent.ts` must not.
- **One owned interaction is presented at a time.** The SDK dispatches
  `can_use_tool` for every tool in a batched assistant message concurrently, so
  a single pending slot silently orphans all but the last; an orphaned request
  blocks the CLI forever and the turn never reaches `result`. `ClaudeOwnedAgent`
  queues them and shows only the head.
- **Owned workspace selection is a security boundary.** Canonicalize configured
  roots and requested paths with real paths; reject nonexistent/inaccessible
  directories, ambiguous relative paths, and symlink escapes. Never create a
  requested directory or trust the phone's `provider`/`cwd` fields.
- **Idle is debounced (`IDLE_GRACE_MS`).** herdr flips to idle transiently
  between tool calls (its prompt box flashes), so committing immediately blanks
  the thinking indicator and fires a spurious `result` mid-turn. Only commit
  turn-end after idle persists; a `busy` signal cancels it. Do **not** cancel on
  content — the final block lands during the grace (jsonl lags herdr) and there
  is no second idle to re-arm the timer, so that would strand the turn forever.

## even-terminal protocol: four consumption semantics

The app renders each event type differently. Emit the right one (full field-level
reference — every type, both directions — in `docs/PROTOCOL.md`):

| Semantic | Events | App behavior |
|----------|--------|--------------|
| Append (immutable) | `text_delta` `user_prompt` `result` `notification` | added to the transcript |
| Keyed update | `tool_start`→`tool_end` (shared `toolId`) | one bubble, running→done — this is how we render tools |
| Single-slot widget | `status` `running_stats` `task_progress` | overwrites one UI element |
| Interactive | `permission_request` `user_question` ⇄ responses | menu + reply |

Map `TodoWrite` to `task_progress`, not a tool bubble (`todoProgress` in
`bridge.ts`). Emit `running_stats` every 10s during a turn.

## Code style

- Strict TypeScript. `any` is forbidden — use `unknown` + narrowing.
- ESM only (`import ... from "./x.js"` with the `.js` extension).
- **User-facing strings default to English** (notification titles/messages).
- Match existing style; surgical changes only — every changed line should trace
  to the task. Comments state constraints the code can't, not narration.

## Verification (before declaring a nontrivial change done)

`pnpm check` is necessary but not sufficient — the real test is what the glasses
app receives. `pnpm sim` drives a whole turn against a real agent, menus
included; `--fake` swaps in fixtures when the code under test is even-better's
own plumbing rather than an agent integration. For a recorded, scoreable
transcript instead:

1. Start a test server on an unused port: `PORT=3457 BRIDGE_TOKEN=... LOG_FILE=/tmp/eb.log LOG=trace pnpm start`.
2. Create a scratch herdr workspace (`workspace.create` over the socket), run
   `claude` in its pane, let the bridge upgrade it to the transcript.
3. Record with `tools/app-sim.ts <port> <token> <paneId> <out.jsonl>`, drive a
   turn via `POST /api/prompt`, then inspect the recording (or `LOG_FILE`) to
   confirm the exact events the app got.
4. Clean up the scratch workspace (`workspace.close`) afterward.

For Grok changes, also run `pnpm test:app-grok`. The real pre-release gate is
`GROK_SMOKE=1 pnpm smoke:grok`; it creates and removes its own empty cwd and
makes exactly one no-tool model request.

`LOG_FILE` records every in/out/diag line — the first place to look when the
glasses show something wrong. `LOG=trace` traces capture/send/drop per line.

## Extension roadmap — what NOT to build yet

`Multiplexer` is now extracted (`multiplexer.ts` + `herdr.ts`/`cmux.ts`) — its
bar was met by a named second backend. `AgentAdapter` is **not** yet: claude and
codex still live as branches in `bridge.ts`/transcript parsers, and that is
fine until agent-specific behavior grows beyond timeline parsing and menu/key
grammar. Do not extract it (or the `src/source/` subtree) on symmetry alone. No
`Renderer`/`Transport` interfaces while there is one device and one protocol;
keep render as pure functions.

## Git

- Conventional commits (`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`).
- Run `pnpm check` + the relevant unit test before committing.
