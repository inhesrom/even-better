# ADR 0004: Restore the stock-launcher setup flow

- Status: Accepted
- Date: 2026-07-24
- Supersedes: ADR 0003

## Context

ADR 0003 assumed the stock Even App would render and answer a `user_question`
emitted after opening an ordinary server session row. Physical-phone traces
disproved that assumption: even-better emits a valid provider question when
**＋ Agent setup** opens, but the stock app ignores questions initiated from an
existing row. The same payload works after the app submits its null-session
voice prompt and connects to the public ID returned by the server.

The stock app always renders **＋ New Session**, and selecting it still makes no
server request. Its first `POST /api/prompt` is therefore the only supported
creation signal available without changing the app.

Owned mode must keep one creation row, preserve the user's first prompt through
agent and directory selection, retain a stable public ID, and continue exposing
Claude and Grok through the app's Codex connection.

## Decision

`/api/sessions` lists remembered sessions only. The stock app owns the sole
**＋ New Session** row.

A null or missing `sessionId` on `POST /api/prompt` creates a transient setup
session, retains that prompt, and returns `202` with a stable public ID. The
session is titled **Setting up agent session…** while its SSE stream asks for an
agent provider and eligible directory. Additional prompts targeting unfinished
setup return `409`.

After provider startup succeeds, even-better persists the native resume ID and
first prompt, appends the prompt to display history, converts the same public ID
into a remembered session, and dispatches the prompt through the owned bridge
exactly once. A provider-start failure retains the prompt and reopens setup.

Owned mode continues to report Codex as the compatibility `provider` in
`/api/info`, session descriptors, status, prompt responses, and results.
Remembered sessions additionally report their real `agentProvider`.

## Consequences

- The unchanged phone app shows exactly one creation row.
- Setup starts after the first voice prompt because row selection is not visible
  to the server.
- Setup and the remembered session share one public ID.
- Provider startup and native persistence precede first-prompt dispatch.
- Setup questions, workspace validation, leases, process limits, and reconnect
  replay remain unchanged.
- Unfinished setup is transient and may lose its retained prompt on server
  restart; remembered sessions remain durable.
