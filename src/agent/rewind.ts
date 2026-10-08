/**
 * Rewind: put the library and the conversation back to how they were just
 * before a chosen node (「rewind 到某个节点前」).
 *
 * Two kinds of node:
 *  - a **user message** — undo everything the agent did in answer to it and
 *    after, drop the message and what follows, and hand its text back to the
 *    input box so it can be edited and resent;
 *  - a **batch** (one `apply_changes` call) — undo that batch and every later
 *    one, and cut the conversation just before the call.
 *
 * The library half is `ops.jumpBefore(anchor)`, where the anchor is the
 * earliest undo step inside the cut. The undo log is one straight line, so
 * that also undoes any manual edits the user made after that step; they are
 * counted here so the confirmation can say so (user decision 2026-09-24:
 * accept it, but warn).
 *
 * Pure. The caller does the writes.
 */

import type { Turn } from "./types";

export interface RewindPoint {
  turnIdx: number;
  /** null = the whole turn (a user message); a number = before that block. */
  blockIdx: number | null;
}

export interface RewindPlan {
  /** Turns that survive, the last one possibly cut short. */
  keep: Turn[];
  /** First index that is dropped — everything from here goes. */
  dropFrom: number;
  /** Earliest undo step inside the cut; null when the cut wrote nothing. */
  anchor: number | null;
  /** Undo steps the agent made inside the cut. */
  steps: number[];
  /** Text for the input box when rewinding to a user message. */
  restoreText: string | null;
}

export function planRewind(turns: Turn[], point: RewindPoint): RewindPlan {
  const keep: Turn[] = [];
  const steps: number[] = [];
  let restoreText: string | null = null;
  let dropFrom = turns.length;

  for (const turn of turns) {
    if (turn.idx < point.turnIdx) {
      keep.push(turn);
      continue;
    }
    const cutAt = turn.idx === point.turnIdx && point.blockIdx !== null ? point.blockIdx : 0;
    if (turn.idx === point.turnIdx) {
      if (point.blockIdx === null && turn.role === "user") {
        restoreText = turn.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      }
      if (cutAt > 0) keep.push({ ...turn, blocks: turn.blocks.slice(0, cutAt) });
      dropFrom = cutAt > 0 ? turn.idx + 1 : turn.idx;
    }
    for (const b of turn.blocks.slice(cutAt)) {
      if (b.type === "tool" && typeof b.seq === "number") steps.push(b.seq);
    }
  }

  steps.sort((a, b) => a - b);
  return { keep, dropFrom, anchor: steps[0] ?? null, steps, restoreText };
}

export type RewindStatus =
  | { ok: true; undo: number; manual: number }
  /** The anchor step is no longer in the undo log — evicted, or discarded. */
  | { ok: false };

/**
 * Whether a rewind can still be done exactly, and what it will cost.
 *
 * @param log the undo log's keys and cursor (`ops.logIndex`)
 * @param agentSteps every step any agent session made — so that a batch from
 *   another session is not miscounted as the user's own manual edit
 */
export function rewindStatus(
  plan: RewindPlan,
  log: { seqs: number[]; cursor: number },
  agentSteps: ReadonlySet<number>
): RewindStatus {
  if (plan.anchor === null) return { ok: true, undo: 0, manual: 0 };
  const at = log.seqs.indexOf(plan.anchor);
  if (at === -1) return { ok: false };
  const target = log.seqs[at - 1] ?? 0;
  const undone = log.seqs.filter((s) => s > target && s <= log.cursor);
  return { ok: true, undo: undone.length, manual: undone.filter((s) => !agentSteps.has(s)).length };
}

export type StepState = "applied" | "undone" | "gone";

/** How a batch's undo step stands now — the badge on its row. */
export function stepState(seq: number, log: { seqs: number[]; cursor: number }): StepState {
  if (!log.seqs.includes(seq)) return "gone";
  return seq <= log.cursor ? "applied" : "undone";
}
