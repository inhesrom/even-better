# Plan: glasses mode switching (Plan / Normal / Auto)

Branch: `feat/agent-mode-switch` · Worktree: `~/repo/even-better-mode-switch`
Status: agreed 2026-07-28 (grilled interview); not yet implemented.

## Goal

Let the glasses user switch an owned session's agent mode by voice — "change to
auto mode", "switch to plan mode" — or via a picker menu, for Claude and Codex.

## Decisions (settled — do not relitigate without cause)

| # | Decision |
|---|----------|
| 1 | **Owned sessions only.** Mux (herdr/cmux) out of scope: no reliable mode read-back exists for a TUI pane, and silent failure on glasses is worse than absence. |
| 2 | **Claude + Codex first-class; Grok opportunistic.** Grok ships only if surfacing ACP `availableModes` + `session/set_mode` proves trivial during implementation; otherwise defer. |
| 3 | **Three neutral modes, no bypass/danger tier.** Mapping is per-adapter (see table below). |
| 4 | **Trigger = whole-prompt template match** in `owned-commands.ts`; substring matches never steal a prompt. Bare/ambiguous → picker menu. |
| 5 | **Feedback = `notification` on switch + `·` marker in picker.** No persistent widget (mode would fight turn state for the single `status` slot). Current mode is tracked from provider truth, never assumed. |
| 6 | **Mode persists in session metadata**, reapplied on every attach/resume. Sticky until changed. |
| 7 | **Idle-only switching.** Mid-turn = interrupt first, then switch. No bypass of the turn state machine. |
| 8 | **Claude `ExitPlanMode` gets a three-option menu** (Approve & auto / Approve, ask each step / Keep planning). Codex has no plan-ready moment — accepted asymmetry; no plan-detection heuristics. |
| 9 | **Invariant amendment:** "Commands are enumerated, never invented" gains a carve-out for the bridge-level `/mode` synthetic — defined in `owned-commands.ts`, dispatched to `OwnedAgent.setMode?()`, never sent to a provider as text. Codex prompts stay byte-identical for everything else. |

## Mode mapping

| Glasses mode | Claude (`setPermissionMode`) | Codex (`thread/settings/update`) |
|---|---|---|
| **Plan** | `plan` | `sandboxPolicy: {type:"readOnly"}` + `approvalPolicy: "on-request"` |
| **Normal** | `default` | `sandboxPolicy: {type:"workspaceWrite", ...}` + `approvalPolicy: "on-request"` |
| **Auto** | `acceptEdits` | `sandboxPolicy: {type:"workspaceWrite", ...}` + `approvalPolicy: "never"` |

Claude Auto is deliberately `acceptEdits`, not `bypassPermissions` — on glasses,
silent arbitrary shell execution is too much trust.

## Verified protocol facts (probed 2026-07-28, do not re-derive)

- **Claude** (`@anthropic-ai/claude-agent-sdk` 0.3.218): `Query.setPermissionMode(mode)`
  works at runtime in streaming-input mode (which we use). `PermissionMode =
  'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`. Current
  mode is reported in `system/init` (`mode` field). The `canUseTool` allow
  response accepts `PermissionUpdate {type:'setMode', mode, destination}` —
  this is how the ExitPlanMode approval carries the mode transition.
  `src/claude-owned-agent.ts:195` currently hard-codes `permissionMode: "default"`.
- **Codex** (`codex app-server`, verified on 0.145.0 only):
  - `thread/settings/update` accepts `approvalPolicy`, `sandboxPolicy`,
    `approvalsReviewer`, `model`; server confirms with a
    `thread/settings/updated` notification. This is the switch mechanism.
  - `turn/start` also accepts per-turn overrides (unused by this plan; noted
    for the future).
  - **Field-name trap:** runtime updates use `sandboxPolicy` (internally tagged
    object: `readOnly`|`workspaceWrite`|`dangerFullAccess`|`externalSandbox`).
    The plain-string `sandbox` field (`read-only`|`workspace-write`|…) exists
    **only on `thread/start`**; sending `sandbox` on other methods is *silently
    ignored* — a naive port would no-op without error.
  - `approvalPolicy` values on 0.145.0: `untrusted|on-request|granular|never`
    (no `on-failure`; `granular` is a struct variant — do not use).
  - **0.142.5 is unverified.** Feature-detect at runtime: on
    `thread/settings/update` error, `setMode` rejects and the bridge emits a
    "Mode switching unavailable" notification. Never gate the provider itself.
- **Grok** (`@agentclientprotocol/sdk` 1.3.0): `session/new`/`load`/`resume`
  responses carry optional `modes: {currentModeId, availableModes}`;
  `session/set_mode` switches; `current_mode_update` notifies. We currently
  **discard** all of it (`grok-acp-normalize.ts:197` lumps `current_mode_update`
  into `{kind:"metadata"}`; `grok-acp-process.ts` reads only `sessionId` from
  `session/new`). Modes are agent-defined — surface them raw, no neutral
  mapping for Grok.

## Implementation steps

### 1. `OwnedAgent` capability seam — `src/owned-agent.ts`

```ts
export type AgentMode = "plan" | "normal" | "auto";
export interface OwnedAgent {
  // …existing…
  /** Optional capability, like commands(). Resolves once the provider
   *  confirms the change; rejects if unsupported at runtime. */
  setMode?(mode: AgentMode): Promise<void>;
  /** Current mode as last confirmed by the provider, null before known. */
  mode?(): AgentMode | null;
}
```

Provider-neutral vocabulary stops here; native mode ids never cross this seam
(same rule as ACP IDs staying on the producer side).

### 2. Claude adapter — `src/claude-owned-agent.ts`

- `setMode`: map to `PermissionMode`, call `this.queryHandle.setPermissionMode()`.
- Track current mode from `system/init`'s `mode` field (late-bound, like the
  model — same reason: init only arrives once a turn begins). Until then,
  report the mode we were *started* with.
- Startup: thread the persisted mode into `query()` options `permissionMode`
  (replacing the hard-coded `"default"`).
- **ExitPlanMode:** in `canUseTool`, when the tool is `ExitPlanMode`, mark the
  queued interaction so the bridge renders the three-option plan menu instead
  of the generic permission menu. The allow response for options 1/2 carries
  `updatedPermissions: [{type:'setMode', mode: 'acceptEdits'|'default', destination:'session'}]`;
  option 3 denies. Respect the one-at-a-time interaction queue invariant.

### 3. Codex adapter — `src/codex-owned-agent.ts`

- `setMode`: send `thread/settings/update` with `approvalPolicy` +
  `sandboxPolicy` per the mapping table (mind the `sandboxPolicy` field-name
  trap). Resolve on the RPC response; treat `thread/settings/updated` as the
  confirmation that updates `mode()`. Bounded timeout like every other
  provider call.
- Startup: derive `thread/start`'s `sandbox` + `approvalPolicy` from the
  persisted mode instead of the current hard-coded values (keep today's values
  as the Normal defaults).
- On any error from `thread/settings/update` (e.g. 0.142.5): reject; do not
  retry, do not restart the thread.

### 4. Trigger matching — `src/owned-commands.ts`

- `parseModeInput(text): {kind:"switch", mode} | {kind:"menu"} | null` —
  whole-prompt, case-insensitive template match:
  - `/mode`, `mode` → menu
  - `/mode <m>`, `<m> mode`, `(change|switch|go) to <m> mode`,
    `(change|switch) mode to <m>` → switch, where `<m>` ∈
    plan|normal|default|auto (synonyms map in).
  - Template matched but mode word unrecognized → menu.
  - Anything else (including substring hits) → `null`, prompt passes through
    untouched.
- All heuristics stay in this file (existing rule). Unit-test the negative
  cases hard: "change to auto mode detection in the parser" must pass through.

### 5. Bridge dispatch — `src/owned-session-bridge.ts`

- In the prompt path, before command resolution: `parseModeInput`. On match,
  and only when the session is idle and `agent.setMode` exists:
  - **Switch:** open a turn (same shape as command questions — `user_prompt` +
    `status: busy` prime), `await agent.setMode(mode)`, emit `notification`
    ("Mode: Auto — edits apply without asking"), persist, terminalize.
    On rejection: notification "Mode switching unavailable", terminalize.
  - **Menu:** command-question machinery, 4 options (Plan / Normal / Auto /
    Cancel), current mode marked with `·` (U+00B7 — one of the two glyphs
    proven to render). Every exit terminalizes; `interrupt()` special-casing
    already covers command questions — extend it to the mode question.
  - No `setMode` capability (mux-adopted edge, hypothetical providers):
    pass the text through unchanged.
- Busy session: existing 409 behavior, nothing new.

### 6. Persistence — `src/owned-session-store.ts` / catalog

- Add optional `mode` to session metadata (default `"normal"` when absent —
  matches today's behavior). Write through the existing `persist()` path
  (turn-completion invariant: persistence must never wedge the turn).
- `attachNow` / resume passes the stored mode into the adapter's start config.
- Update stored mode on: explicit switch, ExitPlanMode menu choice, and any
  provider-initiated mode change Claude reports.

### 7. Grok (opportunistic — timebox, defer freely)

- Read `modes` from `session/new`/`load` responses; stop discarding
  `current_mode_update`. If present, `setMode` maps by fuzzy id match or
  surfaces the raw list in the picker. If this exceeds ~a day, cut it and note
  in the ADR.

### 8. Docs

- **CLAUDE.md:** amend the "Commands are enumerated, never invented" invariant
  with the `/mode` carve-out (decision 9). Add `owned-commands.ts` note.
- **New ADR** (`docs/adr/0008-mode-switching.md` or next number): record
  decisions 1–9, the Codex field-name trap, and the 0.142.5 feature-detect.
- `docs/PROTOCOL.md` untouched — no new wire events; we reuse
  `user_question`/`notification`.

## Testing

- `scripts/test-*` unit suites: `parseModeInput` templates + hard negatives;
  mapping tables per adapter.
- `pnpm test:app-owned`-style deterministic server test: switch via template,
  switch via menu, cancel, busy-session rejection, unavailable-capability
  fallthrough, persistence across detach/reattach. Respect
  `assertPrimedQuestion` (ADR 0005 prime + deferral applies to the menu).
- Claude fake must **not** announce `system/init` eagerly (existing invariant)
  — mode late-binding must be exercised.
- Real-model gates (explicit opt-in only): `CLAUDE_SMOKE=1 pnpm smoke:claude` /
  `CODEX_SMOKE=1 pnpm smoke:codex` extended with one mode round-trip;
  `pnpm sim` for an eyeball pass on menu rendering.
- `pnpm check` before every commit.

## Risks / open edges

- **Codex 0.142.5** behavior unknown → covered by runtime feature-detect.
- **Codex Plan is a simulation** (read-only sandbox): the agent may try to
  write and get sandbox denials; acceptable, but the Plan notification text for
  Codex should say "read-only" rather than promise plan output.
- **Option-count ceiling** (unknown, >4 known-bad at 11): both menus are ≤4
  options — keep it that way if modes grow.
- **Provider-initiated mode changes** (Claude `plan` self-exit paths): trust
  `system/init`/settings notifications as truth; the persisted value follows
  provider truth, not user intent.
