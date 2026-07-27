# ADR 0002: Stock launcher and prompt-triggered setup

- Status: Superseded by ADR 0003
- Date: 2026-07-24
- Supersedes: ADR 0001

## Context

The stock Even App always renders its own **＋ New Session** row. A physical-phone
trace shows that it creates a provider session by posting the first prompt with
`sessionId:null`, then connects to the stable public ID returned by the server.

Adding a synthetic launcher to `/api/sessions` therefore produces two creation
rows. The app-owned row cannot open a server wizard when merely selected because
selection makes no HTTP request; the first observable creation request is the
null-session prompt.

Owned mode must still choose an agent and eligible directory before starting a
provider process, preserve one public ID through setup, and expose Claude and
Grok sessions through the app's Codex connection.

## Decision

`/api/sessions` exposes setup and remembered sessions only. The stock app owns
the sole New Session launcher.

When `/api/prompt` receives a null or missing session ID, the owned catalog
creates a transient setup session, retains that first prompt, and returns its
stable public ID. Its SSE stream asks for the agent and directory. Completing
setup persists the remembered session and sends the retained prompt to the new
provider context. The transient row is titled **Setting up agent session…** so
it cannot be mistaken for another launcher.

Owned mode reports Codex as the compatibility `provider` in `/api/info`, every
session descriptor, status, prompt response, and result. Completed sessions
also report their real `agentProvider`, and their titles name it.

## Consequences

- The unchanged phone app shows exactly one creation row.
- Setup starts after the user submits the first prompt, which is the first server
  notification the stock launcher provides.
- The first prompt is intentionally retained until setup completes.
- Setup and the remembered session share one public ID.
- `provider` is compatibility identity in owned mode; diagnostics and domain
  logic use `agentProvider` for the real agent.
- Phone-supplied `provider` and `cwd` remain untrusted compatibility inputs; the
  wizard and canonical workspace policy are authoritative.
