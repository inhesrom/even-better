# ADR 0005: Run the setup wizard before the prompt

- Status: Accepted
- Date: 2026-07-27
- Refines: ADR 0004

## Context

ADR 0004 restored prompt-triggered setup after ADR 0003's **＋ Agent setup** row
failed on a physical phone. Its finding was that "the stock app ignores questions
initiated from an existing row", and the conclusion drawn was that a
server-authored row cannot host a menu. That conclusion made the ordering
permanent: agent and directory could only be chosen *after* the user had already
composed a prompt, because the null-session `POST /api/prompt` is the only
creation signal the app emits.

The finding was real but the cause was never established. Re-measuring it on a
physical phone, against a spiked ＋ Agent setup row, distinguished five shapes:

| Variant | Prime before the question | Question timing | Renders |
|---|---|---|---|
| 1 | `status:busy` + `user_prompt` | same tick as stream open | no |
| 2 | `status:busy` | same tick | no |
| 3 | `user_prompt` | same tick | no |
| 4 | `text_delta` | same tick | no |
| 5 | `user_prompt` | **500 ms after stream open** | **yes** |

Variant 5 rendered the agent menu and its answer reached
`POST /api/question-response`; the wizard then ran to completion on the glasses.
So the constraint is **timing plus a prime**, not row provenance: a
`user_question` emitted in the same tick as the stream opening is dropped, and
the app renders it once the stream first carries something turn-shaped. ADR
0003's design was sound and its implementation was one `setTimeout` short.

Which of the prime and the delay is individually load-bearing was not isolated —
variants 1–4 all shared the same-tick timing.

Separately, the directory question showed only four options
(`workspaces.choices(4)`), mixing recently-used directories, the root, and its
children — so launching in `~/repo` offered four things rather than the repos.

## Decision

The wizard runs before the prompt.

`/api/sessions` always lists exactly **one** wizard row. Untouched it is titled
**＋ Agent setup**; once a ＋ New Session prompt adopts it, **Setting up ·
excerpt**; while its provider boots, **Starting Agent · folder…**. Only a setup
that has begun starting frees the slot, so the list offers one way in at a time.
The row is catalog state, never persisted, and minted fresh after a restart.

Opening its SSE stream emits a `user_prompt` prime, then the outstanding question
after `SETUP_QUESTION_DELAY_MS` (default 500). Every stream open primes,
reconnects included. Answers emit their follow-up question synchronously; only
the first question after a stream opens needs the deferral.

A wizard that completes with no retained prompt starts the provider, persists the
remembered session, and emits `status: idle` plus a **Ready — say your prompt**
notification. `firstPrompt` is written only for a prompt that actually runs, so
the row is titled `Agent · folder` until the first spoken prompt fills it. The
readiness notification is re-emitted on reconnect while `firstPrompt` is unset,
because `notification` is append-only and the app never replays.

The stock **＋ New Session** row is unchanged: its null-session prompt adopts the
wizard row, is retained through both questions, and is dispatched exactly once
after startup. Nothing is discarded.

The directory question lists every eligible directory, most-recently-used first,
excluding dot-directories that have never been used. `WIZARD_DIRECTORY_LIMIT`
(default `0` = unlimited) caps it.

## Consequences

- Agent and directory are chosen before any prompt exists.
- The app shows two creation rows; suppressing its own requires an app change.
- The prime appears in the transcript as a `user_prompt` reading
  `New agent session`. Isolating whether the delay alone suffices would remove it.
- A remembered session can exist with no prompt and no history.
- `SETUP_QUESTION_DELAY_MS` is device-dependent timing, not preference; 500 ms is
  one measurement on one phone.
- Emitting the wizard's first question synchronously silently breaks the flow with
  no server-side error. `assertPrimedQuestion` in `scripts/test-owned-server.ts`
  is the regression guard.
- Setup remains transient: an unfinished wizard and its retained prompt are still
  lost on restart.
