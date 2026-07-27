# even-better domain language

Use these terms consistently in code, tests, logs, and documentation.

- **Stock session launcher**: the app-owned **＋ New Session** row. The unchanged
  stock app always renders it and opens its voice-first composer. Its null- or
  missing-session prompt adopts the wizard row rather than creating a second one.
- **Wizard row**: the single server-listed setup session the catalog always
  offers, titled **＋ Agent setup** until something claims it. Opening it asks for
  an agent provider and an eligible directory *before* any prompt exists — the
  reason it exists. It is catalog state: never persisted, minted fresh after a
  restart.
- **Setup session**: that same session once a wizard is under way. It has a stable
  public ID, may retain exactly one first prompt (**Setting up · excerpt**), and
  reads **Starting Agent · folder…** while its provider boots. Successful setup
  starts and persists the provider under the same public ID and turns it into a
  remembered session; a retained prompt is dispatched exactly once, and with none
  the session lands idle and asks for one.
- **Render prime**: the `user_prompt` emitted when a wizard stream opens, before
  its deferred first question. The app drops a `user_question` that shares a tick
  with the stream opening (ADR 0005); the prime and the delay together are what
  make the menu render.
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
