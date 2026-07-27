# ADR 0003: Immediate Agent setup launcher

- Status: Superseded by ADR 0004
- Date: 2026-07-24
- Supersedes: ADR 0002

## Context

The stock Even App always renders its own **＋ New Session** row and selecting
it opens a voice-first composer without notifying the server. Prompt-triggered
setup therefore delays agent and directory selection until after the user has
already supplied conversational input, and requires even-better to retain that
input while no provider session exists.

The server can also expose a normal session descriptor whose SSE stream opens
as soon as the row is selected. The two rows cannot be collapsed without a
phone application change, so they must be visibly and behaviorally distinct.

Owned mode must begin setup before conversational input, keep one public ID
through configuration, persist the native provider context before its first
prompt, and continue exposing Claude and Grok through the app's Codex
connection.

## Decision

`/api/sessions` always lists one non-persisted **＋ Agent setup** row before
remembered sessions. Opening its SSE stream immediately presents agent
selection followed by eligible-directory selection. Setup never retains a
prompt.

After directory selection, even-better starts the selected provider session and
atomically persists its native resume ID under the launcher's public ID. That
same row becomes the remembered session. A replacement launcher is created
only after setup succeeds. Before the first conversational prompt its title is
**Provider · folder**; afterward it appends a short first-prompt excerpt.

Null-session prompts and prompts targeting a setup launcher are rejected with
guidance to open **＋ Agent setup**. The stock app's separate **＋ New
Session** row remains voice-first.

Owned mode continues to report Codex as the compatibility `provider` in
`/api/info`, session descriptors, status, prompt responses, and results.
Remembered sessions additionally report their real `agentProvider`.

## Consequences

- The unchanged app visibly shows two distinct creation rows with distinct
  behavior.
- Setup begins on selection, before any conversational prompt exists.
- Public IDs remain stable across launcher-to-remembered transformation.
- The launcher is catalog state only and never survives a restart.
- Native persistence, history, resume, workspace validation, leases, attached
  process limits, and Codex compatibility identity remain unchanged.
- Suppressing or changing the stock row requires a future phone application
  change and is outside this decision.
