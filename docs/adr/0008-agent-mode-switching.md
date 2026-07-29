# ADR 0008: Switching the agent's mode from the glasses

- Status: Accepted
- Date: 2026-07-28
- Builds on: ADR 0005 (the turn a bridge-local menu rides in)
- Revisits: ADR 0006, which rejected a synthetic `/forget` command

## Context

An owned session ran in whatever permission mode its provider started in, for
the life of the session. On the glasses that is the one place you cannot fix it:
there is no terminal to press shift+tab in, so a session that should have been
planning was already editing, and a session you wanted to run unattended asked
about every edit. Plan-first work — the thing a heads-up display is *good* at,
because you listen to a plan rather than read a diff — was unreachable.

The provider APIs were already there and unused. Claude's Agent SDK exposes
`Query.setPermissionMode()` at runtime (legal in streaming-input mode, which is
the only mode this adapter runs in) and `claude-owned-agent.ts` hard-coded
`permissionMode: "default"` at startup. Codex's app-server exposes
`thread/settings/update`. What was missing was a vocabulary, a trigger, and
somewhere to keep the answer.

## Decision

**Three neutral modes — Plan, Normal, Auto — behind an optional `OwnedAgent`
capability, triggered by whole-prompt matching, persisted per session.**

| Glasses mode | Claude (`setPermissionMode`) | Codex (`thread/settings/update`) |
|---|---|---|
| **Plan** | `plan` | `collaborationMode: plan` + `sandboxPolicy: readOnly` + `approvalPolicy: on-request` |
| **Normal** | `default` | `collaborationMode: default` + `workspaceWrite` + `on-request` |
| **Auto** | `acceptEdits` | `collaborationMode: default` + `workspaceWrite` + `never` |

1. **Owned sessions only.** A mux pane would mean injecting shift+tab and
   confirming by scraping a banner — and `pressAndVerify` confirms by *menu
   disappearance*, which a mode toggle does not do. There is no reliable
   read-back, and a switch that silently fails where the user cannot see a
   terminal is worse than no switch. Mux users have a real terminal somewhere.

2. **Claude and Codex; Grok deferred.** Both daily drivers have real APIs with
   real confirmations. Grok's ACP modes are *agent-defined strings*
   (`availableModes` per session), which the neutral vocabulary cannot express
   without a second, parallel "show whatever the agent advertises" menu.
   `GrokOwnedAgent` implements no `setMode`, so mode phrasing stays an ordinary
   prompt there — the correct degradation, and it is covered by a test.

3. **`OwnedAgent.setMode?()`, optional like `commands?()`.** The neutral
   vocabulary stops at the seam; `PermissionMode` and Codex's three-axis settings
   never cross it, the same rule that keeps ACP ids on the producer side.

4. **Auto is `acceptEdits`, never `bypassPermissions`.** No YOLO tier exists at
   all. On glasses you cannot read a command before it runs, so silent arbitrary
   shell execution is a different order of trust from unattended edits.

5. **Whole-prompt matching, in `owned-commands.ts`.** "change to auto mode",
   "switch to plan mode", "plan mode", "/mode auto"; bare "mode" or an
   unrecognized mode word opens a four-option picker. A prompt that merely
   *contains* those words — "change to auto mode detection in the parser" —
   reaches the agent untouched. This asymmetry is deliberate: a phrasing we miss
   costs one confused answer from the agent, while a prompt we steal is invisible
   on the glasses, and silent misbehaviour is this project's worst failure class.

6. **The mode follows provider truth.** Claude's `system/init` carries
   `permissionMode`; Codex confirms with `thread/settings/updated`. The bridge's
   `mode` event fires only on those, never on what was requested, so a mode the
   agent reached on its own (a plan self-exit) is reported too.

7. **Persisted per session, reapplied on attach.** Sticky until changed. The
   alternative — a session silently reverting on resume — is the same silent
   misbehaviour in the dangerous direction.

8. **Idle-only.** The switch rides the turn machinery, and `prompt()` already
   409s during a turn. Mid-turn switching would need a bypass around the turn
   state machine plus an answer for "what does Plan mean for a tool call already
   in flight". Interrupt, then switch.

9. **Claude's `ExitPlanMode` *is* the mode fork.** When a plan is ready the
   glasses get three options — **Approve & auto** / **Approve, ask each step** /
   **Keep planning** — and the approval carries the switch in its
   `PermissionUpdate {type:'setMode'}`, so there is no second round trip. Codex
   has no plan-ready moment; finishing a plan there means saying "change to auto
   mode" and prompting again. That asymmetry is accepted rather than papered over
   with a plan-detection heuristic on Codex's output.

### Why this is a command when `/forget` was not

ADR 0006 rejected a synthetic `/forget` on three grounds. Two of them do not
apply here, and the third is the reason a synthetic is *required* rather than
merely convenient:

- *"A command runs only from inside a session, so it could not clean up when
  nothing is open."* That was disqualifying for forgetting a session and is
  exactly right for mode, which has no meaning outside one. `/forget` needed a
  row precisely because it acts on sessions from the outside.
- *"Codex advertises no commands at all."* For `/forget` that killed the idea; for
  mode it is the argument *for* a bridge-level synthetic. Codex is a daily driver
  here and a passthrough command could never reach it — only a synthetic can.
- *"`owned-commands.ts` is strictly provider-passthrough."* This is the part ADR
  0006 stated more broadly than the invariant needs. The rule protects adapters
  from fabricating provider vocabulary; a bridge-level synthetic that resolves to
  a **capability call** and never becomes text sends the provider nothing it did
  not advertise. The file already owns "which command did they mean" heuristics,
  so "did they ask for a mode" belongs beside them rather than in the bridge.

The bar for the next synthetic is that all three answers hold again.

## Measured protocol facts

Verified live against the installed CLIs on 2026-07-28. Both corrections below
were found by probing rather than by reading, and neither is inferable from the
published schema.

- **Codex `thread/settings/update` exists and works (0.145.0), but is absent
  from `codex app-server generate-json-schema`.** The schema bundle exports only
  the `thread/settings/updated` *notification*. The method is real — the error
  text for an unknown method enumerates it — so the generated schema is not a
  usable source of truth for what the app-server accepts.
- **Codex has a first-class plan mode.** `collaborationMode/list` advertises
  exactly `Plan` and `Default`, and `thread/settings/update` accepts
  `collaborationMode: {mode, settings}` (`settings.model` is **required** —
  omitting it fails with "missing field `settings`"). Plan is therefore a real
  Codex mode, not a read-only-sandbox simulation as first designed. The
  read-only sandbox is kept as a backstop: the collaboration mode instructs, the
  sandbox enforces.
- **The `sandbox`/`sandboxPolicy` field trap is real.** Runtime updates take
  `sandboxPolicy` (an internally tagged object). The plain-string `sandbox`
  field exists only on `thread/start`; sending it to
  `thread/settings/update` returns `ok` with **no notification and no change** —
  silently ignored. Enum *values* are validated, so only the field name fails
  quietly.
- **Claude's `system/init` field is `permissionMode`, not `mode`.**
- Claude's `PermissionUpdate {type:'setMode', mode, destination:'session'}` rides
  the `canUseTool` allow response, which is what makes the plan fork one step.

## Consequences

- **"Commands are enumerated, never invented" gains one deliberate carve-out.**
  `/mode` is a *bridge-level* synthetic: defined in `owned-commands.ts` where all
  input matching already lives, dispatched to `setMode()`, and **never sent to a
  provider as text**. The invariant's purpose — adapters must not fabricate
  provider commands — is intact, and Codex's prompts stay byte-identical for
  everything else. If a provider ever advertises its own `/mode`, ours shadows
  it; that is the cost, and it is why the carve-out is written down.
- **`OwnedPermissionDecision` grew three plan keys, and validation moved.** The
  bridge now validates a decision against the options the interaction actually
  advertised instead of a hard-coded triple — the same discipline
  `resolveCommand` follows against the command list. An adapter that never
  offers a key can never be handed it.
- **Both menus are four options or fewer** (three modes + Cancel; three plan
  choices). A fourth mode must page rather than grow: eleven options were
  silently not drawn on a physical phone (ADR 0006).
- **A failed switch never gates the provider.** An older Codex that rejects the
  update leaves a perfectly usable session, so the bridge reports "mode
  switching unavailable" and terminalizes. Likewise a mode that cannot be
  *restored* on attach notifies but does not fail the attach — a stranded row
  with no session is strictly worse than a session in the wrong mode.
- **`Plan` on Codex may still surprise.** The collaboration mode is a prompt-level
  instruction; the read-only sandbox is what actually stops a write. An agent
  that tries anyway gets a sandbox denial rather than a plan.
- **Unmapped Claude modes read as Auto.** A user whose own settings start a
  session in `bypassPermissions`/`dontAsk`/`auto` sees "Auto", because they all
  mean "do not ask about edits". Reporting any of them as "Normal" would
  understate the risk in the one direction that matters.
