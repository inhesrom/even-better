# ADR 0001: Synthetic launcher and Codex compatibility identity

- Status: Superseded by ADR 0002
- Date: 2026-07-24

The compatibility-provider decision remains valid, but the synthetic-launcher
decision did not match the stock app's observed creation flow. ADR 0002 records
the corrected combined decision.

## Context

The stock Even app creates and filters sessions through a single configured
provider connection. It cannot be changed to ask for a real coding agent and
workspace before the first prompt, and a Codex-configured connection otherwise
hides Claude and Grok descriptors.

Owned mode must support one QR, three agent providers, setup before any prompt,
and durable re-entry without changing the phone application.

## Superseded decision

The owned catalog always exposes one synthetic **＋ New agent session** row.
Opening that row's SSE stream presents agent selection followed by directory
selection. Completing setup transforms the same public ID into a remembered
session and creates a replacement launcher. Null-session prompts are rejected;
setup never holds a prompt.

Owned mode reports Codex as the compatibility `provider` in `/api/info`, every
session descriptor, status, prompt response, and result. Completed sessions
also report the real `agentProvider`, and their titles name it.

## Superseded consequences

- One unchanged stock-app connection can list and reopen Claude, Codex, and
  Grok sessions.
- Setup is explicit and replayable before conversational input exists.
- `provider` cannot be interpreted as the real agent in owned mode; code and
  diagnostics must use `agentProvider`.
- The launcher is catalog state, not a provider session, and is never persisted.
- Phone-supplied creation provider/cwd fields are untrusted compatibility data;
  the wizard and canonical workspace policy remain authoritative.
