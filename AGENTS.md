# even-better

> This file is the single source of agent instructions ([agents.md](https://agents.md)
> standard — read by Codex, Cursor, Zed, etc.). `CLAUDE.md` is a symlink to it for
> Claude Code. Edit here only; never create a separate per-tool copy.

Use a coding-agent session from Even Realities G2 glasses. A local HTTP/SSE
server speaks the `@evenrealities/even-terminal` protocol so the stock Even app
connects by QR scan. The installed CLI defaults to `SOURCE=owned`: setup-first,
persistent phone sessions that choose Claude, Codex, or Grok plus an eligible
directory. Explicit `SOURCE=mux` mirrors Claude/Codex already running in herdr
or cmux. (`SOURCE=grok` was a third mode owning one `grok agent stdio` ACP
session; it was a fork of the owned bridge and has been retired — owned mode
runs the same ACP child.)

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
- **`owned-commands.ts`** — pure matching of spoken/typed input against the
  provider's advertised command list. Every heuristic for "which command did they
  mean" lives here, the way screen artifacts live in `screen-timeline.ts`.
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
  mode lists durable, lazily attached sessions plus exactly one wizard row
  (**＋ Agent setup**), so agent and directory are chosen before any prompt
  exists. The stock **＋ New Session** row's null-session prompt adopts that same
  row, survives the wizard, and runs after provider startup; a wizard finished
  with no prompt lands idle and asks for one.
- **`owned-manage-session.ts` / `owned-row-question.ts`** — the second synthetic
  row (**＋ Manage sessions**: pick → confirm → `catalog.forget`) and the prime +
  deferral both synthetic rows need to get a menu rendered. That mechanism is one
  measurement, not a preference, so it lives in one place rather than in each row.
- **`owned-agent.ts` / `owned-session-bridge.ts`** — provider-neutral contract
  and common owned bridge. Provider adapters own only their native protocol;
  the common bridge owns public IDs, pacing, interactions, and wire events.
- **`owned-workspaces.ts` / `owned-config.ts` / `owned-session-store.ts`** —
  realpath-enforced directory policy, MRU choices, atomic private persistence,
  leases, executable discovery, limits, and child configuration.
- **`grok-acp-process.ts` / `grok-acp-normalize.ts` / `grok-owned-agent.ts`** —
  owned Grok child + ACP SDK, exhaustive wire normalization, and the `OwnedAgent`
  mapping. Keep ACP/private IDs on this producer side. Grok reaches the wire
  through the common `OwnedSessionBridge` like every other provider.
- **`agent-home.ts`** — where the agent CLIs keep per-user state
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Shared so the transcript tailer and the
  hook installer cannot disagree; when they did, the transcript never resolved
  and transcript-only panes showed nothing at all.
- **`expose.ts`** — public tunnel used by the tunnel `PUBLIC_ACCESS` modes (`tailscale-funnel`/`funnel`|`pinggy`|`bore`|`ngrok`|`cloudflared`): spawns the tunnel CLI, scrapes its URL, prints the one QR. `funnel` (Tailscale) is SSE-verified + auto-tears-down on exit; Cloudflare *quick* tunnels break SSE — noted inline. `index.ts`'s `resolveAccess()` picks the provider and calls `startExpose(name, …)`. It registers only a `process.on("exit")` teardown — a signal handler here would `process.exit()` synchronously and pre-empt `index.ts`'s async shutdown, orphaning the detached owned children.
- **`sse.ts` / `index.ts`** — even-terminal SSE fan-out + HTTP server.
- **`parse.ts`** — screen menu parsing (`parseMenu`/`classifyMenu`).

## Commands

- `pnpm start` — run the server (prints QR). Runs via `tsx`, no build needed.
  `pnpm build` is for packaging only (`bin` → `dist/cli.js`); CI runs it so the
  shipped artifact stays compilable.
- `pnpm check` — `tsc --noEmit -p tsconfig.check.json`, covering `src/`,
  `scripts/`, and `tools/`. Must pass before every commit. (The root
  `tsconfig.json` stays `src`-only because `pnpm build` compiles it with
  `--rootDir src`; checking and emitting are separate configs on purpose.)
- `pnpm test` — runs every `scripts/test-*.ts` suite via the `node:test` runner.
  Run one suite after touching its module with
  `npx tsx --test scripts/test-transcript.ts` (or `test-render`, `test-diff-unit`,
  `test-widgets`, `test-menu`, etc.) — pure-function unit tests.
- End-to-end: `pnpm sim` (`tools/app-tui.ts`) is the maintained client. The older
  `tools/app-sim.ts` + `tools/analyze-sim.py` pair still records/scores a JSONL
  transcript when you want a scoreable artifact. See "Verification" below.
- `pnpm sim` — interactive protocol client standing in for the glasses, not for
  the agents: it launches a real server via `src/cli.ts` (so real providers,
  roots and remembered sessions) and attaches, rendering the four consumption
  semantics and answering permission/question menus. `pnpm sim <port> <token>`
  attaches to a server already running — use that when one is, since two servers
  contend for the session store's leases. `pnpm sim --fake` swaps in
  `scripts/fixtures` and reaches no model; that mode offers Codex and Grok only,
  because Claude has no spawnable fixture (the SDK launches the real CLI).
- `pnpm test:grok` — deterministic Grok ACP protocol test over the owned bridge.
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
  `GrokAcpProcess.fatal()` must `.catch()` its own `dispose()`: `disposeOwned()`
  throws when the group will not reap, and an unhandled rejection reaches
  `index.ts`, which calls `shutdown(1)` — one stuck child would exit the server.
- **Every provider teardown is bounded, and the lease outlives it.** Each dispose
  step takes a timeout (an unbounded `await exitPromise` wedged `dispose()` →
  `catalog.dispose()` → `teardown()`), and `OwnedCatalogSession.dispose()`
  releases its lease in a `finally` so a throwing teardown cannot strand
  `lease.json` on disk.
- **A blocked pane must always emit something.** `emitBlockedMenu` runs only on
  the edge transition into `awaiting`, so returning early without emitting
  strands the session with no menu on the glasses and nothing to re-enter the
  method. Retry, then fall back to a `notification` — never return silently.
- **Leases become visible only with their payload.** `acquireLease` writes a temp
  file and `link`s it into place (atomic, still `EEXIST` when held). The earlier
  `open("wx")`-then-write left the file visible but empty, and a second server
  read it as unparseable, judged it abandoned, and unlinked a live lease — two
  servers then attached the same session.
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
- **Logging must never throw and never grow unbounded.** `console.log` on a closed
  stdout throws `EPIPE`; the tee must call the original inside its own `try`, or
  that throw reaches `index.ts`'s `uncaughtException` handler, which logs via
  `console.error` and throws again — a loop that wrote **5.3 GB into tmpfs in
  5.5 minutes** and starved every other process on the box. Both log files go
  through `cappedAppender` (`LOG_MAX_BYTES`, earliest bytes kept — never rotate,
  the boot banner and first stack are what diagnose a loop), and the event log's
  cap notice is itself JSON because `docs/TROUBLESHOOTING.md` reads that file with
  `jq`. Stdio-death codes are non-fatal in `onFatal`: a lost terminal must not
  dispose live owned sessions.
- **A failed owned startup asks to retry; it never reopens the wizard.** Resetting
  the answers and re-asking agent + directory turned one timing-out provider into
  an infinite loop on the glasses — four full cycles in two minutes, observed.
  `launch()`'s catch keeps `selectedProvider`/`selectedCwd` and asks the single
  `:retry` question, so the wizard advances only on a deliberate tap. `SetupStep`
  is explicit for the same reason: with answers retained, the outstanding question
  can no longer be inferred from `selectedProvider === null`.
- **A synthetic row's first question must not share a tick with the stream
  opening.** The app silently drops it — no error, no retry, a blank row on the
  glasses. ADR 0004 measured that as "server-authored rows cannot host a menu" and
  reverted the whole design; ADR 0005 isolated the real cause. `onConnect` emits a
  `user_prompt` prime and `replayPending` defers the question by
  `SETUP_QUESTION_DELAY_MS`, on every stream open including reconnects. Answers may
  emit their follow-up question synchronously; only the first one after a stream
  opens needs the deferral. Both halves live in `owned-row-question.ts` because the
  wizard and the manage row both depend on them and neither can afford to drift.
  `assertPrimedQuestion` in `test-owned-server.ts` is the guard for both.
- **A question's option count is bounded, and the ceiling is unknown.** Eleven
  options (ten sessions + Cancel) were silently not drawn on a physical phone;
  four are fine. The signature is identical to the same-tick question above — no
  error, nothing rejected, just a row stuck `awaiting` an answer to a menu that
  does not exist, which reads on the glasses as thinking forever. Long menus must
  page (`MANAGE_SESSION_LIMIT`), not grow. `WIZARD_DIRECTORY_LIMIT`'s `0` predates
  this and is unverified for a workspace with many directories.
- **Only ＋ (U+FF0B) and `·` are known to render in a row title.** 🗑 did not.
  Titles are the one place an unrenderable glyph costs a whole feature, since the
  row is how it is reached.
- **Forgetting a session is dispose → drop from the map → `store.remove`.**
  `store.remove()` refuses while `lease.json` exists and the catalog leases every
  eligible row from construction, so the dispose has to come first. The map entry
  goes before the store call, not after: by then the child is dead and the stream
  ended, so a row left behind hands `get(id)` a gutted session. Every persisting
  path (`save`, `onAssistant`, `prompt`) is gated on `disposed`, and `attachNow`
  re-checks it — `store.save()`/`appendHistory()`/`acquireLease()` all call
  `ensureSessionDirectory`, so a resume or a late `activity` hook racing the
  delete would `mkdir` the directory straight back and resurrect the row.
- **A pending setup is reused, never disposed.** `createSetup()` restarts the
  wizard in place on the same public id. Disposing it calls `dropSession`, which
  `res.end()`s the phone's SSE stream with no notification — so the second
  null-session prompt the voice-first ＋ row makes easy to send killed the very
  wizard the glasses were showing. Startup is also fire-and-forget
  (`beginLaunch`): awaiting it held the answer's POST open for the whole cold
  start, and the glasses saw nothing at all until it finished.
- **Teardown must reach a child that is still spawning.** `attachNow` installs the
  bridge only once `start()` resolves, so a `dispose()` landing mid-spawn found
  `session.bridge === null`, disposed nothing, and let the session promote *after*
  shutdown — writing `metadata.json` and leaving a live bridge whose stats interval
  kept the process alive, with a detached codex/grok child orphaned. `startingBridge`
  holds it for that window and `detach()` disposes either one; `attachNow` re-checks
  `disposed` after `start()` so a late resolve cannot promote.
- **Turn completion must always terminalize.** `finishTurn` sets `terminalizing`,
  which gates `prompt()` (409) and `interrupt()` (early return), so it must clear
  in a `finally` and the persistence hooks (`model`/`assistant`/`activity`, all
  synchronous session-store writes) must run through `persist()`. An ENOSPC there
  otherwise skips `result` + `status: idle` and wedges the session until restart —
  losing a history line is the acceptable failure.
- **A command question opens a turn that has not reached the provider.** The
  picker/args/confirm menus are emitted inside the turn `prompt()` started, so
  every exit must terminalize: Cancel is on every question, and `interrupt()`
  special-cases them because `agent.interrupt()` finds no active turn and returns
  a no-op, leaving the session busy with nothing running. Sitting inside the turn
  is also what makes the menu render at all: it puts `user_prompt` + `status:
  busy` on the stream ahead of the question, which is the same prime ADR 0005
  measured the wizard needs. (ADR 0004 read this as "the app ignores a question
  the user's prompt did not trigger"; ADR 0005 found the real constraint is that
  the stream must first look like a turn and the question must not share a tick
  with a stream opening. Both features land on the same shape either way.)
- **Commands are enumerated, never invented.** `OwnedAgent.commands()` is an
  optional capability (like `Multiplexer.explain()`) and execution is passthrough
  — `prompt("/name args")`, which Claude and Grok parse themselves. Codex
  advertises nothing, so its prompts must stay byte-identical to the pre-command
  path. All matching lives in `owned-commands.ts` and never in an adapter.
- **Claude's local commands need their own message cases.** `/usage`, `/cost` and
  `/context` bypass the query loop entirely and emit only
  `system/local_command_output`; `/compact` emits only `compact_boundary`.
  Dropping those (as `onMessage` did) makes the command run and show nothing.
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

For Grok changes, also run `pnpm test:grok`. The real pre-release gate is
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
