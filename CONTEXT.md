# even-better domain language

Use these terms consistently in code, tests, logs, and documentation.

- **Stock session launcher**: the app-owned **＋ New Session** row. The unchanged
  stock app always renders it and opens its voice-first composer. Its null- or
  missing-session first prompt is the server's creation signal in owned mode.
- **Setup session**: the transient server session created by that first prompt.
  It has a stable public ID and the temporary title **Setting up agent
  session…**, retains exactly one first prompt, and asks for an agent provider
  and eligible directory. Successful setup starts and persists the provider
  under the same public ID, turns it into a remembered session, and dispatches
  the retained prompt exactly once. It is not durable across server restarts.
- **Remembered session**: an owned session whose stable public ID, immutable
  agent provider and cwd, native resume ID, metadata, and display history are
  persisted by even-better. It can exist without a provider process.
- **Attached session**: a remembered session that currently has a live provider
  adapter/process. `MAX_OWNED_SESSIONS` limits attached sessions, not remembered
  sessions.
- **Workspace root**: a canonical directory that bounds owned-mode selection.
  Explicit CLI roots replace `WORKSPACE_ROOTS`, which replaces the canonical
  launch cwd default.
- **Eligible directory**: an existing accessible directory whose canonical real
  path is a workspace root or descendant. Symlink escapes, nonexistent paths,
  and ambiguous root-relative paths are not eligible.
- **Compatibility provider**: the provider identity required by the unchanged
  stock phone app. In owned mode it is always Codex on the wire.
- **Agent provider**: the real coding agent behind an owned session: Claude,
  Codex, or Grok. It appears as `agentProvider` and in session titles.

The provider's native transcript is authoritative for conversational context.
even-better's normalized history is a display/recovery copy, not a substitute
for the native session.
