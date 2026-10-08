/**
 * The agent loop for one session.
 *
 *   user message → [ stream a response → run its tool calls ] × N → done
 *
 * It keeps going while the model keeps calling tools, up to `maxRounds` per
 * user message, and stops on a plain answer, an error, the round limit, or the
 * Stop button. Every write tool call is planned against a fresh snapshot,
 * waits for approval when it has to, and lands as one undo step through the
 * data port; its seq is kept on the block as the rewind anchor.
 *
 * UI-agnostic: state lives on this object and `onChange` tells the view to
 * re-read it. The panel throttles those to animation frames, which is what
 * keeps a fast stream from re-rendering per token.
 */

import { port } from "../app/dataport";
import { snapshot } from "../core/store";
import type { Lang, T } from "../ui/i18n";
import { ApiError, streamChat } from "./client";
import { buildMessages } from "./context";
import { IdRegistry } from "./ids";
import { systemPrompt } from "./prompt";
import { Assembler } from "./providers";
import { planRewind, type RewindPoint } from "./rewind";
import { resolveAccess } from "./scope";
import { putTurn, saveSession, truncateTurns } from "./sessions";
import {
  describeOutcome,
  planChanges,
  REMEMBER_TOOL,
  runReadTool,
  TOOL_SPECS,
  WRITE_TOOL,
  type ToolEnv
} from "./tools";
import type { AiConfig, Session, ToolBlock, Turn } from "./types";

export interface RunnerDeps {
  config: AiConfig;
  lang: Lang;
  t: T;
  /** State changed; re-read `turns`, `running`, `awaiting`. */
  onChange: () => void;
  /** A batch committed; these item keys changed (for the grid's highlight). */
  onCommitted: (touched: string[]) => void;
}

const INTERRUPTED = "[Not executed: the run stopped before this call ran.]";

export class AgentRunner {
  private ids: IdRegistry;
  private abort: AbortController | null = null;
  private pending: { block: ToolBlock; resolve: (ok: boolean) => void } | null = null;
  private persisted: boolean;
  running = false;

  constructor(
    public session: Session,
    public turns: Turn[],
    private deps: RunnerDeps
  ) {
    this.ids = new IdRegistry(session.ids);
    this.persisted = turns.length > 0;
  }

  setDeps(deps: RunnerDeps): void {
    this.deps = deps;
  }

  /** The batch waiting for 执行 / 拒绝, if any. */
  get awaiting(): ToolBlock | null {
    return this.pending?.block ?? null;
  }

  private changed(): void {
    this.deps.onChange();
  }

  private async saveMeta(): Promise<void> {
    this.session.ids = this.ids.toJSON();
    this.session.updatedAt = Date.now();
    await saveSession(this.session);
    this.persisted = true;
  }

  // --- sending ------------------------------------------------------------------------

  private nextIdx(): number {
    return (this.turns.at(-1)?.idx ?? -1) + 1;
  }

  async send(text: string): Promise<void> {
    const body = text.trim();
    if (!body || this.running) return;
    // Claimed before the first await, so a double-press cannot start two runs.
    this.running = true;
    if (!this.persisted || this.turns.length === 0) this.session.title = body.replace(/\s+/g, " ").slice(0, 60);
    const userTurn: Turn = {
      sessionId: this.session.id,
      idx: this.nextIdx(),
      role: "user",
      blocks: [{ type: "text", text: body }],
      ts: Date.now()
    };
    this.turns.push(userTurn);
    this.changed();
    try {
      await putTurn(userTurn);
    } catch (err) {
      this.running = false;
      this.changed();
      throw err;
    }
    await this.loop();
  }

  /**
   * Carry on without a new message — 重试 after an error, 继续 after a stop,
   * the round limit or a cut-off reply. A trailing reply that failed before
   * doing anything is dropped first, so the model answers afresh instead of
   * being asked to continue half a sentence.
   */
  async resume(): Promise<void> {
    if (this.running || this.turns.length === 0) return;
    this.running = true;
    const last = this.turns.at(-1)!;
    if (last.role === "assistant") {
      const didWork = last.blocks.some((b) => b.type === "tool" && b.status !== "error");
      if ((last.stop === "error" || last.stop === "aborted") && !didWork) {
        await truncateTurns(this.session.id, last.idx);
        this.turns.pop();
      } else if (last.stop) {
        delete last.stop;
        delete last.error;
        delete last.errorKind;
        await putTurn(last);
      }
    }
    await this.loop();
  }

  /** The caller has already set `running`. */
  private async loop(): Promise<void> {
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const nextIdx = () => this.nextIdx();
    this.session.model = this.deps.config.model;
    await this.saveMeta();

    const cfg = this.deps.config;
    let rounds = 0;
    try {
      for (;;) {
        if (signal.aborted) break;
        const last = this.turns.at(-1);
        if (rounds >= cfg.maxRounds) {
          if (last && last.role === "assistant") {
            last.stop = "round_limit";
            await putTurn(last);
          }
          break;
        }
        rounds++;

        const snap = await snapshot();
        const messages = buildMessages(this.turns);
        const turn: Turn = { sessionId: this.session.id, idx: nextIdx(), role: "assistant", blocks: [], ts: Date.now() };
        const asm = new Assembler();
        turn.blocks = asm.blocks;
        this.turns.push(turn);
        this.changed();

        try {
          await streamChat(
            cfg,
            {
              system: systemPrompt({
                scope: this.session.scope,
                folders: snap.folders,
                autoApply: cfg.autoApply,
                // Read fresh each round: a preference saved mid-run applies to the next request.
                preferences: this.deps.config.preferences
              }),
              messages,
              tools: TOOL_SPECS,
              maxTokens: cfg.maxTokens
            },
            signal,
            (ev) => {
              asm.apply(ev);
              this.changed();
            }
          );
        } catch (err) {
          asm.finish();
          const e = err instanceof ApiError ? err : new ApiError("network", 0, String(err));
          turn.stop = e.kind === "aborted" ? "aborted" : "error";
          if (e.kind !== "aborted") {
            turn.errorKind = e.kind;
            turn.error = e.status ? `${e.status} ${e.detail}` : e.detail;
          }
          this.closeTools(turn, INTERRUPTED);
          this.addUsage(turn, asm);
          await putTurn(turn);
          break;
        }

        asm.finish();
        this.addUsage(turn, asm);
        if (asm.error) {
          turn.stop = "error";
          turn.errorKind = "server";
          turn.error = asm.error;
          this.closeTools(turn, INTERRUPTED);
          await putTurn(turn);
          break;
        }
        if (asm.stop === "max_tokens") turn.stop = "max_tokens";
        await putTurn(turn);
        this.changed();

        const tools = turn.blocks.filter((b): b is ToolBlock => b.type === "tool");
        if (tools.length === 0) break;
        for (const block of tools) {
          if (signal.aborted) {
            block.status = "error";
            block.output = INTERRUPTED;
            continue;
          }
          await this.execute(block, signal);
          await putTurn(turn);
          this.changed();
        }
        if (signal.aborted) {
          turn.stop = "aborted";
          await putTurn(turn);
          break;
        }
      }
    } finally {
      this.running = false;
      this.abort = null;
      await this.saveMeta().catch(() => {});
      this.changed();
    }
  }

  private addUsage(turn: Turn, asm: Assembler): void {
    turn.usage = { ...asm.usage };
    this.session.usage = {
      input: this.session.usage.input + asm.usage.input,
      output: this.session.usage.output + asm.usage.output
    };
  }

  /** Every call gets an answer, even one that never ran — both APIs insist. */
  private closeTools(turn: Turn, output: string): void {
    for (const b of turn.blocks) {
      if (b.type === "tool" && b.output === undefined) {
        b.status = "error";
        b.output = output;
      }
    }
  }

  stop(): void {
    this.abort?.abort();
    this.decide(false);
  }

  decide(approve: boolean): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(approve);
  }

  // --- tools ----------------------------------------------------------------------------

  private async env(): Promise<ToolEnv> {
    const snap = await snapshot();
    return { snap, access: resolveAccess(this.session.scope, snap), ids: this.ids, lang: this.deps.lang, t: this.deps.t };
  }

  private async execute(block: ToolBlock, signal: AbortSignal): Promise<void> {
    const { t } = this.deps;
    if (block.input === null) {
      block.status = "error";
      block.brief = { key: "aiBriefBadArgs" };
      block.output =
        "Error: your arguments for this call were not valid JSON — most likely cut off because the " +
        "response hit its output limit. Send a smaller batch.";
      return;
    }

    if (block.name === REMEMBER_TOOL) {
      await this.remember(block, signal);
      return;
    }

    if (block.name !== WRITE_TOOL) {
      const r = runReadTool(block.name, block.input, await this.env());
      block.output = r.output;
      block.brief = r.brief;
      block.digest = r.digest;
      block.status = r.output.startsWith("Error") ? "error" : "done";
      return;
    }

    let env = await this.env();
    let plan = planChanges(block.input, env);
    block.preview = plan.preview;
    block.errors = plan.errors;
    const summary =
      plan.summary || (plan.preview[0] ? t(plan.preview[0].key, plan.preview[0].vars) : t("aiBriefApplyNothing"));
    block.brief = { key: "aiBriefApply", vars: { summary } };

    if (plan.ops.length === 0) {
      block.status = plan.errors.length ? "error" : "done";
      block.brief = { key: "aiBriefApplyNothing" };
      block.output = describeOutcome(plan, this.ids, true);
      return;
    }

    // Deleting always asks, whatever the setting: in this app a delete needs
    // a confirmation, and the model deciding to delete is exactly the case.
    if (!this.deps.config.autoApply || plan.hasDelete) {
      // Register the wait *before* announcing it: whoever reacts to the change
      // reads `awaiting`, and must find this block there.
      const approved = await new Promise<boolean>((resolve) => {
        this.pending = { block, resolve };
        block.status = "awaiting";
        this.changed();
        if (signal.aborted) this.decide(false);
      });
      if (!approved) {
        block.status = "rejected";
        block.output = signal.aborted ? INTERRUPTED : describeOutcome(plan, this.ids, false);
        return;
      }
      // Time has passed; plan again on what is there now.
      env = await this.env();
      plan = planChanges(block.input, env);
      block.preview = plan.preview;
      block.errors = plan.errors;
    }

    const seq = await port.applyAgentOps(summary, plan.ops);
    block.seq = seq;
    block.status = "done";
    block.output = describeOutcome(plan, this.ids, true);
    this.session.steps.push(seq);
    await this.saveMeta();
    this.deps.onCommitted(plan.touched);
  }

  /**
   * `remember_preference`: always asks, whatever auto-apply says — it changes
   * what every future session is told, so the user decides.
   */
  private async remember(block: ToolBlock, signal: AbortSignal): Promise<void> {
    const text = typeof block.input?.text === "string" ? block.input.text.trim().replace(/\s+/g, " ") : "";
    if (!text) {
      block.status = "error";
      block.brief = { key: "aiBriefBadArgs" };
      block.output = "Error: text is empty.";
      return;
    }
    block.brief = { key: "aiBriefRemember" };
    block.preview = [{ key: "aiPvRemember", vars: { text } }];
    const current = (this.deps.config.preferences ?? "").trim();
    if (current.split("\n").some((line) => line.replace(/^[-*]\s*/, "").trim() === text)) {
      block.status = "done";
      block.output = "Already in the user's preferences; nothing to save.";
      return;
    }
    const approved = await new Promise<boolean>((resolve) => {
      this.pending = { block, resolve };
      block.status = "awaiting";
      this.changed();
      if (signal.aborted) this.decide(false);
    });
    if (!approved) {
      block.status = "rejected";
      block.output = signal.aborted
        ? INTERRUPTED
        : "The user chose not to save this preference. Do not propose it again in this conversation.";
      return;
    }
    const next = current ? `${current}\n- ${text}` : `- ${text}`;
    await port.saveAiConfig({ preferences: next });
    this.deps.config = { ...this.deps.config, preferences: next };
    block.status = "done";
    block.output = "Saved. Future sessions will follow it.";
  }

  // --- rewind ---------------------------------------------------------------------------

  /**
   * Put library and conversation back to just before `point`. The caller has
   * already shown the confirmation (with `rewindStatus`). Returns the text to
   * put back in the input box, or "gone" when the anchor step has left the log.
   */
  async rewind(point: RewindPoint): Promise<{ restoreText: string | null } | "gone" | "busy"> {
    if (this.running) return "busy";
    const plan = planRewind(this.turns, point);
    if (plan.anchor !== null) {
      const moved = await port.jumpBefore(plan.anchor);
      if (moved === null) return "gone";
    }
    await truncateTurns(this.session.id, plan.dropFrom);
    const last = plan.keep.at(-1);
    if (last && last.idx === point.turnIdx) await putTurn(last);
    this.turns = plan.keep;
    await this.saveMeta();
    this.changed();
    return { restoreText: plan.restoreText };
  }
}

export function newSession(scope: Session["scope"]): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    scope,
    createdAt: now,
    updatedAt: now,
    ids: { chats: [], folders: [] },
    usage: { input: 0, output: 0 },
    model: "",
    steps: []
  };
}
