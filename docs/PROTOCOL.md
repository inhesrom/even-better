# even-terminal protocol (as spoken by even-better)

even-better is an **independent, interoperable** implementation of the wire
protocol the stock Even app speaks with `@evenrealities/even-terminal` — matched
to interoperate, with no SDK dependency and no code from that package, so this
file is the reference for what we actually emit and accept. The transport
is plain JSON: outbound events are Server-Sent Events on `GET /api/events`
(`id: <n>\ndata: <json>\n\n`); inbound is ordinary HTTP. Replay on reconnect is
driven by `?needReplay=true` / `GET /messages?after=N`, **not** by `Last-Event-ID`
(neither server honors it — see [Transport & resilience](#transport--resilience)).
The `type` field is the whole contract — the app owns the visual, we only choose
the type and fill its fields.

## Outbound (server → glasses, over SSE)

Every event falls into one of four **consumption semantics**; the app renders by
which bucket a `type` belongs to. Emit the right one (see `bridge.ts`).

### 1. Append — immutable, added to the transcript

Once sent it cannot be edited (this is why prose is buffered and rendered whole
before emit — see `renderForGlasses`).

| type | fields | meaning |
|------|--------|---------|
| `text_delta` | `text` | assistant prose, streamed a few code points per tick |
| `user_prompt` | `text` | one user turn (typed from anywhere) |
| `result` | `success, text, sessionId, costUsd, provider, agentProvider?, turns, durationMs, inputTokens, outputTokens` | a turn's closing summary |
| `notification` | `title, message` | an informational message (e.g. "respond in the terminal") |

### 2. Keyed update — one bubble, running → done (shared `toolId`)

`tool_start` opens a bubble; `tool_end` with the same `toolId` closes it. The app
labels and colours the tool event.

| type | fields |
|------|--------|
| `tool_start` | `name, toolId, summary, detail:{ input }` |
| `tool_end` | `name, toolId, summary, detail:{ input, output }` |

### 3. Single-slot widget — overwrites one UI element (never appends)

| type | fields | notes |
|------|--------|-------|
| `status` | `state: "busy" \| "idle" \| "awaiting", sessionId, provider?, agentProvider?` | the thinking indicator |
| `running_stats` | `durationMs, inputTokens, outputTokens` | emitted every 10s during a turn |
| `task_progress` | `completed, total, current` | from `TodoWrite` / Codex `update_plan` (`todoProgress`/`planProgress`) |

### 4. Interactive — menu + reply, in pairs

The request opens a menu on the glasses; the app answers via an inbound endpoint
(below); the server then emits the paired result as an acknowledgement.

| request | fields | paired result | fields |
|---------|--------|---------------|--------|
| `permission_request` | `toolName, description, detail, toolUseId, options:[{ text, key }], suggestions` | `permission_result` | `toolName, summary, decision: "always" \| "allowed" \| "denied"` |
| `user_question` | `questions:[{ question, header, options:[{ label, description, preview }] }], toolUseId` | `question_answer` | `answers:{ answer }` |

## Inbound (glasses → server, plain HTTP)

All under `/api`, bearer-token auth (`?token=` or `Authorization: Bearer`).

| method | path | purpose |
|--------|------|---------|
| GET | `/events` | subscribe to the SSE stream (`?sessionId=`) |
| GET | `/sessions` | list mirrored panes, standalone Grok, or remembered owned sessions; the stock app supplies owned mode's creation row |
| GET | `/info` | model / provider / version |
| GET | `/status` | one live session's state |
| GET | `/messages` | ring-buffer replay (`?after=`) |
| GET | `/update-check` | version check (static) |
| GET | `/sessions/:id/history` | recent display history as `{ history:[{ role, text }] }` |
| DELETE | `/sessions/:id` | **not stock** — the app never sends it. Permanently forgets a remembered owned session (`405` where the source cannot). The ＋ Manage sessions row reaches the same code path |
| POST | `/prompt` | inject a user turn (`{ text, sessionId }`); in owned mode a null/missing ID creates a transient setup session and returns `202` with its stable ID, while a second prompt during setup returns `409` |
| POST | `/permission-response` | answer a `permission_request` (`{ sessionId, decision }`) |
| POST | `/question-response` | answer a `user_question` (`{ sessionId, answer }`) |
| POST | `/interrupt` | interrupt the session (`{ sessionId }`): Escape for mux, ACP cancellation for Grok |

## Transport & resilience

> Describes even-terminal **0.8.1** (official npm dist, `routes/events.js`).
> even-better is **byte-compatible** with the package's SSE format; every
> difference below is an **intentional deviation — do not "fix" it back**.

**SSE wire format** (must stay identical — the app's EventSource parser is fixed):
- On connect: a comment line `:ok\n\n` **before anything else**.
- Per message: `id: N\ndata: {json}\n\n`.
- Heartbeat: `:heartbeat\n\n` every **15 s** per client; a write-throw drops the client.
- Headers: `text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`, flushed before `:ok`.
- Comment lines (`:ok`, `:heartbeat`) have no `id:`/`data:` — ignored by EventSource per spec (never dispatched as a message). Their real value is keeping idle-timeout network layers (proxies, NAT, mobile radios) from treating the connection as dead — a network-stack effect, **not** an EventSource-spec guarantee. (`src/sse.ts`)

**Ring buffer & replay:**
- Per-session FIFO, `MAX_MESSAGES_PER_SESSION = 500`, **in-memory only** (lost on restart).
- Replay is triggered by `?needReplay=true` **only** — never delta-from-id.
- ⚠️ **Deviation:** the package replays the *whole* buffer; even-better caps to the
  **last 20** (`REPLAY_MAX`, `src/sse.ts`) to avoid flooding the glasses after a long
  disconnect. Precise unbounded catch-up is available via `GET /api/messages?after=N`.

**Dead-client / half-open detection:**
- Both drop a client on a `res.write()` throw (broadcast + heartbeat paths) and on `req.on('close')`.
- ⚠️ **Deviation (even-better):** a `socket.on('error')` errno log (how the socket
  died) + diagnostics — `reconnect_gap`, connection `lived` time, "no live client —
  buffering", "write/heartbeat failed — dropped dead client". (`src/sse.ts`)
- ❗ The server **cannot quickly detect a half-open socket** (phone off Wi-Fi): the
  15s heartbeat keeps the socket non-idle so TCP keepalive never fires, and Node
  exposes no `TCP_USER_TIMEOUT`, so an unacked write only fails on TCP's
  multi-minute retransmit timeout. This is an **app-side limitation** — see below.

**Auth:** the stream mounts under the same bearer middleware as all `/api`;
EventSource cannot set headers, so it requires `?token=`. even-better uses
`timingSafeEqual` + an ephemeral per-process token unless `BRIDGE_TOKEN` is set
explicitly; the package uses plain `!==` + an ephemeral per-process token.

### Reconnect / resume

Reconnect behavior, as recorded by the `src/sse.ts` logging:

- The Even app **never sends `Last-Event-ID`** (`lastEventId=-` on every connect),
  **never sets `needReplay=true`** on reconnect, and **never polls
  `/messages?after`** for live sessions (3 `/messages` calls in a full day's log —
  2 stale herdr sessions + 1 manual probe). So **on SSE reconnect the app receives
  nothing from the gap**: append-only events (`text_delta`/`result`/`tool_*`)
  buffered during a drop are lost; single-slot widgets (`status`/`running_stats`)
  self-heal on the next emit. The app uses none of the three catch-up mechanisms,
  so **no server-side replay can reach it** without a client change.
- **The real failure is interactivity, not content.** A half-open SSE socket
  (phone off Wi-Fi / suspended) leaves the app's EventSource believing it is still
  connected, so it never reconnects → the glass session goes unresponsive and
  **stays stuck** (tapping into it does nothing). Losing a few buffered events is
  acceptable; a stuck session is not.
- **What the server can and can't do:** un-sticking a frozen session is
  fundamentally **app-side** — the server can neither detect the half-open socket
  quickly (above) nor force a network-down phone's EventSource to reconnect (a
  server-side close can't reach it until the network returns, and even then the
  app must notice). So the server does the honest, limited things:
  - `retry: 2000` on connect — once the app *does* notice the drop, EventSource
    reconnects in 2s and keeps retrying. (`src/sse.ts`)
  - `socket.on('error')` + `[sse]` diagnostics for observability. (`src/sse.ts`)
  - No gap replay — reconnect content loss is acceptable; the priority is
    "reconnect and keep interacting".
- **In practice:** clean disconnects (the common case — app backgrounds / graceful
  close) reconnect on their own fine, including a 16-min inactivity gap. Half-open
  events are rare — so the "stuck" case is rarer than the clean-drop case, and it
  remains an app-side gap the server cannot close.

**Intentional deviations from 0.8.1 (do not revert):** last-20 replay cap;
immediate `status` snapshot pushed on connect (else an app connecting while idle
waits forever for a transition); `retry: 2000` + socket-error logging; timing-safe
token comparison; static `/update-check`; no `/debug/*` or `/metrics` routes.

## Provider compatibility and owned-mode exception

even-better reports a **single** `provider` to the app — `/api/info` and the QR
connection default both derive it from the focused/first agent
(`providerForAgent(target)`, `focusedOrFirstBridge`). `/api/sessions` *does*
return every pane tagged with its own `provider`, but a connected app is
configured for one type, so **only that agent type's sessions surface on the
glasses**. Two agent types cannot be shown at once; to see the other, make it the
focused agent so `/info` reports it (i.e. switch the host's type). Prerequisite —
the agent must also be tracked by the mux (`docs/MULTIPLEXERS.md` §Prerequisites).

`SOURCE=owned` intentionally reports `provider:"codex"` from `/api/info`, every
session descriptor, `/status`, status events, prompt responses, and results, and
ignores the phone's `?provider=codex` session filter. Codex is only the static
app's compatibility handshake. Completed owned rows additionally carry
`agentProvider:"claude"|"codex"|"grok"`; titles also expose the real provider.
The catalog lists remembered sessions plus exactly **one** wizard row, which
carries no `agentProvider`. Untouched its title is **＋ Agent setup**; once a
＋ New Session prompt adopts it, **Setting up · excerpt**; while its provider
boots, **Starting Agent · folder…**. Only a setup that has begun starting frees
the slot for the next row. It is catalog state — never persisted, minted fresh
after a restart. The stock app additionally renders its own **＋ New Session**
row, which remains voice-first and never appears in `/api/sessions`.

A second synthetic row, **＋ Manage sessions**, appears once at least one session
is remembered and sorts directly after the wizard. It removes sessions and does
nothing else: a prompt to it returns `409`, and it is never a `default()` target.
Its questions are `owned-manage:<id>:pick` (remembered sessions oldest-first,
labelled `<n> · Agent · folder`, plus **More sessions…** when a page remains, plus
**Cancel**) and `owned-manage:<id>:confirm` (**Delete forever** / **Keep**).
Deleting ends that session's SSE stream, so the app sees the row disappear on its
next `/api/sessions` poll.

**A question's option count is bounded, and the bound is unknown.** Eleven options
were silently not drawn on a physical phone — same failure signature as the
same-tick question in ADR 0005: no error, no frame rejected, just a row awaiting an
answer to a menu that is not there. The delete menu therefore pages at
`MANAGE_SESSION_LIMIT` (default 4) and has no unlimited setting, unlike
`WIZARD_DIRECTORY_LIMIT`, whose `0` predates this measurement and is now suspect
for a workspace with many directories.

Opening either synthetic row's `/events` stream emits a `user_prompt` prime, then
the outstanding question after `SETUP_QUESTION_DELAY_MS` (default 500). **A
`user_question` emitted in the same tick as the stream opening is silently
dropped by the app** — see ADR 0005 for the measurement. Every stream open
primes, reconnects included; answers emit their follow-up question synchronously,
so only the first question after a stream opens needs the deferral.

A ＋ New Session prompt has a null or missing `sessionId`; owned mode adopts the
wizard row, retains the prompt, and returns `202` with its stable public ID. An
additional prompt to an unfinished wizard returns `409`.

After provider startup, owned mode persists the native resume ID, converts that
same public ID into a remembered session, and — if a prompt was retained —
appends it to display history and emits its `user_prompt` exactly once through
the owned bridge. With no retained prompt the session lands `status: idle` with a
**Ready — say your prompt** notification, `firstPrompt` unset, and a title of
`Agent · folder` until the first spoken prompt fills it; that notification
re-emits on reconnect while `firstPrompt` is unset, since `notification` is
append-only and the app never replays. Startup failure keeps the transient
session and retained prompt
and asks one retry question (`toolUseId` `owned-setup:<id>:retry`) offering
**Retry** / **Change directory** / **Change agent**, keeping both earlier
answers; it never re-asks the agent and directory questions on its own. While a
question is outstanding, a further null-session prompt restarts the wizard in
place on the **same** public ID; one that arrives while the provider is starting
gets its own transient session instead, since the first is already committed to
a spawning child and a retained prompt. Neither case ever drops a stream. The
directory answer returns as soon as it is accepted — provider startup runs in the
background and reports over SSE. The phone's creation and follow-up `provider` and `cwd`
fields are ignored; the glasses wizard is authoritative and cannot retarget an
existing remembered session.

## Command questions

Owned mode reuses `user_question` for slash commands (`docs/OWNED.md`). Their
`toolUseId` is `owned-command:<sessionId>:<pick|args|confirm>`, distinguishing
them from the wizard's `owned-setup:` questions and from a provider's own
questions, which carry `owned-question:`.

A command question is emitted **inside a turn** — `user_prompt` and
`status: busy` go first, exactly as for a provider question — and the turn stays
open until the chosen command finishes, so one `result` closes the whole
interaction. This is deliberate, and it is the same requirement the wizard has:
the stream must carry something turn-shaped before a `user_question` renders (ADR
0005). A command question satisfies it for free, since `prompt()` already emits
`user_prompt` and `status: busy` ahead of it. The answer is consumed by the
bridge and never reaches the provider.

## Not wire types

Grepping `type: "..."` also hits two values that are **not** protocol events:
`search` is the input of a Codex `web_search` tool call (it rides inside a
`tool_start` `detail.input`), and `input_text` is a parameter name in the Codex
transcript parser. Neither is emitted to the app.
