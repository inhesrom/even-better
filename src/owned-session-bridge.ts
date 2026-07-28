import { randomUUID } from "node:crypto";
import {
  AGENT_MODES,
  type AgentMode,
  type OwnedAgent,
  type OwnedAgentEvent,
  type OwnedAgentSink,
  type OwnedAgentStartInfo,
  type OwnedCommand,
  type OwnedPermissionDecision,
  type OwnedUsage,
} from "./owned-agent.js";
import {
  commandText,
  isDestructive,
  parseAnswer,
  parseCommandInput,
  parseModeInput,
  resolveCommand,
  suggestCommands,
} from "./owned-commands.js";
import { OutputStream } from "./output-stream.js";
import { renderForGlasses } from "./render.js";
import { SessionControlError, type SessionState } from "./session.js";
import { emit } from "./sse.js";

const STREAM_TICK_MS = (() => {
  const raw = Number(process.env.STREAM_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 140;
})();

interface ToolState {
  publicId: string;
  name: string;
  input: unknown;
  output: string;
  ended: boolean;
}

type Interaction =
  | { type: "permission"; toolName: string; options: OwnedPermissionDecision[] }
  | { type: "question" }
  // A bridge-local interaction: its answer resolves a command and never reaches the
  // provider. `pick` chooses among near-misses, `args` collects a command's input,
  // `confirm` guards a destructive command.
  | { type: "command"; stage: "pick" | "args" | "confirm"; candidates: OwnedCommand[]; chosen: OwnedCommand | null; args: string }
  // Also bridge-local: the mode picker. Its answer is a capability call, never text.
  | { type: "mode" };

type CommandPlan =
  | { kind: "prose" }
  | { kind: "dispatch"; text: string }
  | { kind: "ask"; interaction: Extract<Interaction, { type: "command" }> };

const CANCEL = "Cancel";

const MODE_LABEL: Record<AgentMode, string> = { plan: "Plan", normal: "Normal", auto: "Auto" };

const MODE_BLURB: Record<AgentMode, string> = {
  plan: "Research and plan only; nothing is edited.",
  normal: "Ask before edits and commands.",
  auto: "Edits apply without asking.",
};

/** Appended to the mode the session is already in. `·` is one of only two glyphs
 *  measured to render in this app; a check mark or a bullet is a blank space. */
const CURRENT_MARK = " · current";

/** What the app shows after a permission answer. Keyed by the decision so the
 *  plan fork's three keys read as themselves rather than as a bare "Allowed". */
const PERMISSION_RESULT: Record<OwnedPermissionDecision, { summary: string; decision: string }> = {
  allow: { summary: "Allowed", decision: "allowed" },
  allowAlways: { summary: "Allowed for this session", decision: "always" },
  deny: { summary: "Denied", decision: "denied" },
  planAuto: { summary: "Plan approved — Auto", decision: "allowed" },
  planNormal: { summary: "Plan approved — Normal", decision: "allowed" },
  planKeep: { summary: "Still planning", decision: "denied" },
};

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { value: input };
}

function providerName(provider: OwnedAgent["provider"]): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok";
}

export interface OwnedSessionBridgeHooks {
  model?(model: string): void;
  assistant?(text: string): void;
  activity?(): void;
  unavailable?(): void;
  mode?(mode: AgentMode): void;
}

/** Provider-neutral owner of public ids, wire events, pacing, and turn state. */
export class OwnedSessionBridge implements OwnedAgentSink {
  readonly provider = "codex" as const;
  readonly agentProvider: OwnedAgent["provider"];
  readonly cwd: string;
  state: SessionState = "idle";

  private readonly out: OutputStream;
  private model = "Unknown";
  private available = false;
  private disposed = false;
  private terminalizing = false;
  private turnStartedMs = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private proseBuffer = "";
  private lastProseBlock = "";
  private tools = new Map<string, ToolState>();
  private interaction: Interaction | null = null;
  private availableCommands: OwnedCommand[] = [];
  private pendingWire: object | null = null;
  private turnUsage: OwnedUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  private assistantHistory = "";
  /** Provider truth, updated only from the agent's `mode` event. Seeded to the
   *  same default the providers start in so the picker has a mark before the
   *  first report. */
  private currentMode: AgentMode = "normal";

  constructor(
    readonly id: string,
    private readonly agent: OwnedAgent,
    private readonly hooks: OwnedSessionBridgeHooks = {},
  ) {
    this.agentProvider = agent.provider;
    this.cwd = agent.cwd;
    this.out = new OutputStream((message) => emit(this.id, message), STREAM_TICK_MS);
  }

  /** `mode` is the session's remembered mode, reapplied here rather than passed into
   *  each provider's own startup options: it runs the same capability call a user
   *  switch does, so there is one code path to get wrong. No prompt can reach the
   *  agent before this resolves, so the window in which the mode is still the
   *  provider's default contains no turns. */
  async start(nativeSessionId?: string, mode?: AgentMode): Promise<OwnedAgentStartInfo> {
    const info = await this.agent.start(this, nativeSessionId);
    this.model = info.model || this.model;
    this.available = true;
    if (mode && mode !== "normal" && this.agent.setMode) {
      try {
        await this.agent.setMode(mode);
      } catch (error) {
        // A session that cannot restore its mode is still a usable session; saying so
        // is better than failing the attach and stranding the row.
        this.out.event({
          type: "notification",
          title: "Mode not restored",
          message: `This session is remembered as ${MODE_LABEL[mode]}, but ${providerName(this.agentProvider)} would not switch: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return info;
  }

  async prompt(text: string): Promise<void> {
    if (!this.available) {
      throw new SessionControlError(`${providerName(this.agentProvider)} session is detached; reopen it and retry.`, 503);
    }
    if (this.state !== "idle" || this.terminalizing) {
      throw new SessionControlError(`${providerName(this.agentProvider)} is already processing a prompt.`, 409);
    }
    // Ahead of command resolution, and only for a provider that can actually switch:
    // everywhere else this text is an ordinary prompt and must stay one. Both this
    // and planCommand() are resolved before the turn opens, so a throw in either
    // cannot strand a turn that nothing will terminalize.
    const wanted = this.agent.setMode ? parseModeInput(text) : null;
    if (wanted) {
      this.openTurn(text);
      if (wanted.kind === "menu") this.askMode();
      else await this.applyMode(wanted.mode);
      return;
    }
    const plan = this.planCommand(text);
    this.openTurn(text);
    // The turn is open before this point, so every path that stops to ask is inside a
    // turn `finishTurn` will close — cancellation included.
    if (plan.kind === "ask") {
      this.askCommand(plan.interaction);
      return;
    }
    try {
      await this.agent.prompt(plan.kind === "dispatch" ? plan.text : text);
    } catch (error) {
      await this.finishFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Open the turn every prompt path runs inside. The `user_prompt` + busy `status`
   *  pair is also the prime a bridge-local menu needs to render (ADR 0005): the
   *  stream has to look like a turn before a question lands on it. */
  private openTurn(text: string): void {
    this.beginTurn();
    emit(this.id, { type: "user_prompt", text });
    emit(this.id, { type: "status", state: "busy", sessionId: this.id, provider: "codex", agentProvider: this.agentProvider });
  }

  /** Decide what a prompt means against the provider's live command list. Ordinary
   *  prose — and every prompt to a provider that advertises nothing — takes the
   *  untouched path it took before commands existed. */
  private planCommand(text: string): CommandPlan {
    if (!this.availableCommands.length) return { kind: "prose" };
    const phrase = parseCommandInput(text);
    if (phrase === null) return { kind: "prose" };
    const resolved = resolveCommand(phrase, this.availableCommands);
    if (!resolved) {
      // Three, not four: Cancel is appended to every command question, and four
      // options is the largest menu the glasses are known to render (the directory
      // step's `choices(4)`). Five is untested, and this is not the place to find out.
      const candidates = suggestCommands(phrase, this.availableCommands, 3);
      // Nothing close enough to offer: hand the provider the slash form anyway. It
      // owns its own command vocabulary and reports an unknown one better than we can
      // guess — and this is also how a command it never advertised still reaches it.
      if (!candidates.length) return { kind: "dispatch", text: `/${phrase}` };
      return { kind: "ask", interaction: { type: "command", stage: "pick", candidates, chosen: null, args: "" } };
    }
    if (resolved.command.argumentHint && !resolved.args) {
      return { kind: "ask", interaction: { type: "command", stage: "args", candidates: [], chosen: resolved.command, args: "" } };
    }
    if (isDestructive(resolved.command)) {
      return { kind: "ask", interaction: { type: "command", stage: "confirm", candidates: [], chosen: resolved.command, args: resolved.args } };
    }
    return { kind: "dispatch", text: commandText(resolved) };
  }

  async respondPermission(decision: string): Promise<void> {
    const pending = this.interaction;
    if (!pending || pending.type !== "permission") {
      throw new SessionControlError(`No matching ${providerName(this.agentProvider)} permission request.`, 409);
    }
    // Validated against what this interaction actually advertised rather than a fixed
    // list, the same discipline `resolveCommand` follows: an adapter that never offers
    // a key can never be handed it, and a new key needs no change here.
    const normalized = pending.options.find((option) => option === decision);
    if (!normalized) {
      throw new SessionControlError(`That permission choice was not offered by ${providerName(this.agentProvider)}.`, 409);
    }
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    try {
      await this.agent.respondPermission(normalized);
      emit(this.id, {
        type: "permission_result",
        toolName: pending.toolName,
        ...PERMISSION_RESULT[normalized],
      });
    } catch {
      throw new SessionControlError(`Could not send the response to ${providerName(this.agentProvider)}.`, 502);
    }
  }

  async respondQuestion(answer: string): Promise<void> {
    if (this.interaction?.type === "command") {
      await this.answerCommand(this.interaction, answer);
      return;
    }
    if (this.interaction?.type === "mode") {
      await this.answerMode(answer);
      return;
    }
    if (!this.interaction || this.interaction.type !== "question") {
      throw new SessionControlError(`No matching ${providerName(this.agentProvider)} question.`, 409);
    }
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    emit(this.id, { type: "question_answer", answers: { answer } });
    try {
      await this.agent.respondQuestion(answer);
    } catch {
      throw new SessionControlError(`Could not send the response to ${providerName(this.agentProvider)}.`, 502);
    }
  }

  async interrupt(): Promise<void> {
    if (this.state === "idle" || this.terminalizing) return;
    if (this.interaction?.type === "command" || this.interaction?.type === "mode") {
      // The pseudo-turn has not reached the provider, so `agent.interrupt()` finds no
      // active turn and returns without doing anything — leaving the session busy with
      // nothing running. Ending the turn here is the only thing that can release it,
      // and it is the escape hatch if a command menu ever fails to render.
      this.interaction = null;
      this.pendingWire = null;
      await this.finishTurn(true, "Cancelled.", true, 0);
      return;
    }
    this.interaction = null;
    this.pendingWire = null;
    this.state = "busy";
    try {
      await this.agent.interrupt();
    } catch {
      throw new SessionControlError(`Could not interrupt ${providerName(this.agentProvider)}.`, 502);
    }
  }

  replayPending(): void {
    if (this.pendingWire) emit(this.id, this.pendingWire);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.available = false;
    this.stopStats();
    this.out.clear();
    if (this.state !== "idle") {
      try {
        await this.agent.interrupt();
      } catch {
        // Disposal continues to process teardown even if cancellation failed.
      }
    }
    await this.agent.dispose();
  }

  event(event: OwnedAgentEvent): void {
    switch (event.type) {
      case "model":
        this.model = event.model || "Unknown";
        // Also a store write, and this one runs inside the provider's event dispatch.
        this.persist(() => this.hooks.model?.(this.model));
        break;
      case "commands":
        this.availableCommands = event.commands;
        break;
      case "mode":
        this.currentMode = event.mode;
        // A store write inside the provider's event dispatch, exactly like `model`.
        this.persist(() => this.hooks.mode?.(event.mode));
        break;
      case "prose":
        this.assistantHistory += event.text;
        this.proseBuffer += event.text;
        this.flushCompleteParagraphs();
        break;
      case "tool":
        this.flushProse();
        this.applyTool(event);
        break;
      case "plan": {
        this.flushProse();
        const completed = event.entries.filter((entry) => entry.status === "completed").length;
        const current = event.entries.find((entry) => entry.status === "in_progress")?.content
          ?? (completed === event.entries.length && event.entries.length
            ? "All done"
            : event.entries.find((entry) => entry.status === "pending")?.content ?? "");
        this.out.event({ type: "task_progress", completed, total: event.entries.length, current });
        break;
      }
      case "usage":
        this.turnUsage = event.usage;
        break;
      case "permission": {
        this.flushProse();
        this.state = "awaiting";
        this.interaction = {
          type: "permission",
          toolName: event.toolName,
          options: event.options.map((option) => option.key),
        };
        const wire = {
          type: "permission_request",
          toolName: event.toolName,
          description: event.description,
          detail: event.description,
          toolUseId: this.tools.get(event.toolId)?.publicId ?? `owned-tool:${randomUUID()}`,
          options: event.options.map((option) => ({ text: option.label, key: option.key })),
          suggestions: [],
        };
        this.pendingWire = wire;
        this.out.event(wire);
        break;
      }
      case "question": {
        this.flushProse();
        this.state = "awaiting";
        this.interaction = { type: "question" };
        const wire = {
          type: "user_question",
          questions: [{
            question: event.question.question,
            header: event.total === 1 ? providerName(this.agentProvider) : `Question ${event.index + 1} of ${event.total}`,
            options: event.question.options,
          }],
          toolUseId: `owned-question:${randomUUID()}`,
        };
        this.pendingWire = wire;
        this.out.event(wire);
        break;
      }
      case "result":
        if (event.usage) this.turnUsage = event.usage;
        this.finishTurn(
          event.success,
          event.text || (event.cancelled ? "Interrupted." : `${providerName(this.agentProvider)} could not complete the turn.`),
          event.cancelled ?? false,
          event.costUsd ?? 0,
        ).catch((error: unknown) => this.reportTurnFailure(error));
        break;
      case "notification":
        this.flushProse();
        this.out.event({ type: "notification", title: event.title, message: event.message });
        break;
      case "fatal":
        this.available = false;
        if (this.state === "idle") {
          emit(this.id, { type: "notification", title: `${providerName(this.agentProvider)} session ended`, message: event.message });
          this.hooks.unavailable?.();
        } else {
          this.finishFailure(event.message)
            .finally(() => this.hooks.unavailable?.())
            .catch((error: unknown) => this.reportTurnFailure(error));
        }
        break;
    }
  }

  /** The mode picker: four options, which is the largest menu the glasses are known
   *  to render. If a fourth mode is ever added this must page rather than grow —
   *  eleven options were silently not drawn on a physical phone. */
  private askMode(): void {
    this.state = "awaiting";
    this.interaction = { type: "mode" };
    const wire = {
      type: "user_question",
      questions: [{
        question: "Which mode should this session run in?",
        header: "Mode",
        options: [
          ...AGENT_MODES.map((mode) => ({
            label: `${MODE_LABEL[mode]}${mode === this.currentMode ? CURRENT_MARK : ""}`,
            description: MODE_BLURB[mode],
          })),
          { label: CANCEL, description: "Leave the mode unchanged." },
        ],
      }],
      toolUseId: `owned-mode:${this.id}`,
    };
    this.pendingWire = wire;
    this.out.event(wire);
  }

  private async answerMode(answer: string): Promise<void> {
    const value = parseAnswer(answer).trim();
    this.interaction = null;
    this.pendingWire = null;
    emit(this.id, { type: "question_answer", answers: { answer: value } });
    if (!value || value.toLowerCase() === CANCEL.toLowerCase()) {
      await this.finishTurn(true, "Mode unchanged.", true, 0);
      return;
    }
    // The label carries the current-mode mark, so compare on its leading word only.
    const wanted = value.split("·")[0].trim().toLowerCase();
    const mode = AGENT_MODES.find((candidate) => MODE_LABEL[candidate].toLowerCase() === wanted);
    if (!mode) {
      // Re-ask rather than guess: an unmatched answer means the app sent something
      // that was never offered, and picking a mode anyway could widen permissions.
      this.askMode();
      return;
    }
    await this.applyMode(mode);
  }

  /** Runs inside the turn `prompt()` opened, so every exit terminalizes — including
   *  the failure path, which reports rather than throws: the phone's POST has long
   *  since returned and a notification is the only surface left. */
  private async applyMode(mode: AgentMode): Promise<void> {
    this.state = "busy";
    try {
      await this.agent.setMode!(mode);
    } catch (error) {
      this.out.event({
        type: "notification",
        title: "Mode switching unavailable",
        message: `${providerName(this.agentProvider)} did not change mode: ${error instanceof Error ? error.message : String(error)}`,
      });
      await this.finishTurn(true, "Mode unchanged.", false, 0);
      return;
    }
    this.out.event({ type: "notification", title: `Mode: ${MODE_LABEL[mode]}`, message: MODE_BLURB[mode] });
    await this.finishTurn(true, `Mode: ${MODE_LABEL[mode]}`, false, 0);
  }

  /** Put a command question on the glasses. Wire-identical to a provider question —
   *  same `user_question` type, same `pendingWire` replay on reconnect — because the
   *  app renders one menu shape and this must not be a second, special one. */
  private askCommand(interaction: Extract<Interaction, { type: "command" }>): void {
    this.state = "awaiting";
    this.interaction = interaction;
    const { question, options } = this.commandQuestion(interaction);
    const wire = {
      type: "user_question",
      questions: [{
        question,
        header: "Command",
        // Cancel is on every stage: an abandoned picker would otherwise hold the turn
        // open forever, and a turn that never terminalizes wedges prompt() and
        // interrupt() for the life of the process.
        options: [...options, { label: CANCEL, description: "Do not run a command." }],
      }],
      toolUseId: `owned-command:${this.id}:${interaction.stage}`,
    };
    this.pendingWire = wire;
    this.out.event(wire);
  }

  private commandQuestion(
    interaction: Extract<Interaction, { type: "command" }>,
  ): { question: string; options: Array<{ label: string; description: string }> } {
    if (interaction.stage === "pick") {
      return {
        question: "Which command did you mean?",
        options: interaction.candidates.map((command) => ({
          label: `/${command.name}`,
          description: command.description || "Run this command.",
        })),
      };
    }
    const command = interaction.chosen!;
    if (interaction.stage === "args") {
      return {
        question: `What should /${command.name} run on? ${command.argumentHint ?? ""}`.trim(),
        // The options are only a shortcut; the directory step already proves the app
        // accepts a typed answer that matches none of them.
        options: [{ label: "No arguments", description: `Run /${command.name} with nothing else.` }],
      };
    }
    return {
      question: `Run /${command.name}? This cannot be undone.`,
      options: [{ label: `Run /${command.name}`, description: command.description || "Run this command." }],
    };
  }

  /** Advance the command interaction. The answer never reaches the provider: the
   *  terminal stage dispatches inside the turn already opened by `prompt()`, so one
   *  `result` still closes it. */
  private async answerCommand(
    interaction: Extract<Interaction, { type: "command" }>,
    answer: string,
  ): Promise<void> {
    const value = parseAnswer(answer).trim();
    this.interaction = null;
    this.pendingWire = null;
    emit(this.id, { type: "question_answer", answers: { answer: value } });
    if (!value || value.toLowerCase() === CANCEL.toLowerCase()) {
      await this.finishTurn(true, "Cancelled.", true, 0);
      return;
    }
    if (interaction.stage === "pick") {
      const wanted = value.replace(/^\//, "").trim().toLowerCase();
      const chosen = interaction.candidates.find((command) => command.name.toLowerCase() === wanted);
      if (!chosen) {
        // Re-ask rather than guess: an unmatched answer here means the app sent
        // something we did not offer, and picking one anyway could run the wrong thing.
        this.askCommand(interaction);
        return;
      }
      if (chosen.argumentHint) {
        this.askCommand({ type: "command", stage: "args", candidates: [], chosen, args: "" });
        return;
      }
      if (isDestructive(chosen)) {
        this.askCommand({ type: "command", stage: "confirm", candidates: [], chosen, args: "" });
        return;
      }
      await this.dispatchCommand(chosen, "");
      return;
    }
    const command = interaction.chosen!;
    if (interaction.stage === "args") {
      const args = value.toLowerCase() === "no arguments" ? "" : value;
      if (isDestructive(command)) {
        this.askCommand({ type: "command", stage: "confirm", candidates: [], chosen: command, args });
        return;
      }
      await this.dispatchCommand(command, args);
      return;
    }
    await this.dispatchCommand(command, interaction.args);
  }

  private async dispatchCommand(command: OwnedCommand, args: string): Promise<void> {
    this.state = "busy";
    const text = commandText({ command, args });
    emit(this.id, { type: "status", state: "busy", sessionId: this.id, provider: "codex", agentProvider: this.agentProvider });
    try {
      await this.agent.prompt(text);
    } catch (error) {
      await this.finishFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private beginTurn(): void {
    this.turnStartedMs = Date.now();
    this.state = "busy";
    this.proseBuffer = "";
    this.lastProseBlock = "";
    this.tools.clear();
    this.interaction = null;
    this.pendingWire = null;
    this.turnUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    this.assistantHistory = "";
    this.terminalizing = false;
    this.startStats();
  }

  private applyTool(event: Extract<OwnedAgentEvent, { type: "tool" }>): void {
    let tool = this.tools.get(event.id);
    if (!tool) {
      tool = {
        publicId: `owned-tool:${randomUUID()}`,
        name: event.name || `${providerName(this.agentProvider)} tool`,
        input: event.input ?? {},
        output: event.output ?? "",
        ended: false,
      };
      this.tools.set(event.id, tool);
      this.out.event({
        type: "tool_start",
        name: tool.name,
        toolId: tool.publicId,
        summary: tool.name,
        detail: { input: inputObject(tool.input) },
      });
    }
    if (event.input !== undefined) tool.input = event.input;
    if (event.output !== undefined) tool.output = event.output;
    if (!tool.ended && (event.status === "completed" || event.status === "failed")) {
      this.endTool(tool, tool.output || (event.status === "completed" ? "Completed." : "Failed."));
    }
  }

  private endTool(tool: ToolState, output: string): void {
    if (tool.ended) return;
    tool.ended = true;
    this.out.event({
      type: "tool_end",
      name: tool.name,
      toolId: tool.publicId,
      summary: tool.name,
      detail: { input: inputObject(tool.input), output },
    });
  }

  private flushCompleteParagraphs(): void {
    for (;;) {
      const boundary = this.proseBuffer.indexOf("\n\n");
      if (boundary >= 0) {
        this.queueProse(this.proseBuffer.slice(0, boundary + 2));
        this.proseBuffer = this.proseBuffer.slice(boundary + 2);
        continue;
      }
      const codePoints = [...this.proseBuffer];
      if (codePoints.length <= 800 || /(^|\n)\s*\|.*\|/.test(this.proseBuffer)) return;
      let at = 800;
      for (let i = 799; i > 0; i--) {
        if (/\s/.test(codePoints[i])) {
          at = i + 1;
          break;
        }
      }
      this.queueProse(codePoints.slice(0, at).join(""));
      this.proseBuffer = codePoints.slice(at).join("");
    }
  }

  private flushProse(): void {
    if (!this.proseBuffer) return;
    this.queueProse(this.proseBuffer);
    this.proseBuffer = "";
  }

  private queueProse(text: string): void {
    if (!text) return;
    this.lastProseBlock = text.trim() || this.lastProseBlock;
    this.out.text(renderForGlasses(text));
  }

  // Turn completion persists history through synchronous fs writes; an EACCES or a
  // full disk must degrade this session, never reject into the process-fatal handler.
  private reportTurnFailure(error: unknown): void {
    console.warn(`[bridge] owned ${this.id} could not finish the turn: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Run a persistence hook. These reach the session store's synchronous fs writes, so
   *  a full disk or EACCES throws here — and a throw between `terminalizing = true` and
   *  the terminal `result` would strand the turn: no result, no idle status, `prompt()`
   *  rejecting 409 and `interrupt()` returning early, for the life of the process.
   *  Losing a history line is the acceptable failure; wedging the session is not. */
  private persist(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.reportTurnFailure(error);
    }
  }

  private finishFailure(message: string): Promise<void> {
    if (this.terminalizing || this.state === "idle") return Promise.resolve();
    return this.finishTurn(false, message, false, 0);
  }

  private async finishTurn(success: boolean, fallback: string, cancelled: boolean, costUsd: number): Promise<void> {
    if (this.terminalizing || this.state === "idle") return;
    this.terminalizing = true;
    // `terminalizing` gates prompt() and interrupt(), so it must be cleared on every
    // exit — otherwise one failure here leaves the session unusable until a restart.
    try {
      this.interaction = null;
      this.pendingWire = null;
      for (const tool of this.tools.values()) {
        if (!tool.ended) this.endTool(tool, cancelled ? "Cancelled." : `${providerName(this.agentProvider)} ended before reporting this tool's result.`);
      }
      this.flushProse();
      await this.out.drain();
      this.stopStats();
      const historyText = this.assistantHistory.trim() || (success ? fallback.trim() : "");
      if (historyText) this.persist(() => this.hooks.assistant?.(historyText));
      emit(this.id, {
        type: "result",
        success,
        text: renderForGlasses(success && this.lastProseBlock ? this.lastProseBlock : fallback),
        sessionId: this.id,
        costUsd,
        provider: "codex",
        agentProvider: this.agentProvider,
        turns: this.turnUsage.turns,
        durationMs: this.turnStartedMs ? Date.now() - this.turnStartedMs : 0,
        inputTokens: this.turnUsage.inputTokens,
        outputTokens: this.turnUsage.outputTokens,
      });
      this.state = "idle";
      this.turnStartedMs = 0;
      emit(this.id, { type: "status", state: "idle", sessionId: this.id, provider: "codex", agentProvider: this.agentProvider });
      this.persist(() => this.hooks.activity?.());
    } finally {
      this.terminalizing = false;
    }
  }

  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      emit(this.id, {
        type: "running_stats",
        durationMs: this.turnStartedMs ? Date.now() - this.turnStartedMs : 0,
        inputTokens: this.turnUsage.inputTokens,
        outputTokens: this.turnUsage.outputTokens,
      });
    }, 10_000);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}
