/**
 * Stored turns → the provider-neutral message list a request is built from.
 *
 * Two jobs:
 *
 * 1. **Re-split tool blocks.** Turns keep each call and its result together;
 *    both wire formats want the call in the assistant message and the result in
 *    the next one. Every call gets a result, even one that never ran (the run
 *    was stopped, or the tab closed mid-call) — both APIs reject a tool call
 *    left unanswered.
 *
 * 2. **Fold old reads, but only when they no longer fit.** This is the second
 *    half of the context strategy (the first is paging and short handles in
 *    `tools.ts`). Read results are kept whole, newest first, until their total
 *    passes a budget; only what lies beyond it is replaced by a one-line digest.
 *    The newest overview is always kept, because its folder handles stay in use;
 *    write results are always kept, because they are short and they are the
 *    record of what was done.
 *
 *    〔修订 2026-09-24〕This used to fold everything older than the last three
 *    model turns. That broke exactly the request users make first — "look it
 *    all over and propose a plan, don't touch anything": with nothing filed,
 *    every folded page was simply read again (user report: 27 tool calls, the
 *    same pages twice). A budget folds only when the context really is full.
 */

import { READ_TOOLS } from "./tools";
import type { Turn } from "./types";

export type NPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; content: string };

export interface NMessage {
  role: "user" | "assistant";
  parts: NPart[];
}

/**
 * Characters of read output sent in full. About 30–40k tokens: a full titles
 * pass over ~1,300 chats fits, with room for a round of summary openings, and
 * it stays well inside any current model's window.
 */
export const READ_BUDGET = 120_000;

const READS = new Set<string>(READ_TOOLS);

export function buildMessages(turns: Turn[], budget = READ_BUDGET): NMessage[] {
  // The newest overview stays whole wherever it is.
  let lastOverview: string | null = null;
  for (const turn of turns) {
    for (const b of turn.blocks) if (b.type === "tool" && b.name === "get_overview" && b.output) lastOverview = b.id;
  }

  // Walk the reads newest → oldest; whatever falls past the budget is folded.
  const folded = new Set<string>();
  let spent = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const blocks = turns[i]!.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (b.type !== "tool" || !READS.has(b.name) || b.output === undefined || b.id === lastOverview) continue;
      spent += b.output.length;
      if (spent > budget && b.digest) folded.add(b.id);
    }
  }

  const out: NMessage[] = [];
  const push = (role: NMessage["role"], parts: NPart[]) => {
    if (parts.length === 0) return;
    const prev = out[out.length - 1];
    // Neither API wants two messages of one role in a row; after a stopped run
    // a user message can follow tool results directly, so merge.
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };

  for (const turn of turns) {
    if (turn.role === "user") {
      const text = turn.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      if (text) push("user", [{ type: "text", text }]);
      continue;
    }

    const calls: NPart[] = [];
    const results: NPart[] = [];
    for (const b of turn.blocks) {
      if (b.type === "text") {
        if (b.text.trim()) calls.push({ type: "text", text: b.text });
        continue;
      }
      calls.push({ type: "tool_call", id: b.id, name: b.name, input: b.input ?? {} });
      let content: string;
      if (b.output === undefined) {
        content = "[Not executed: the run was interrupted before this call completed.]";
      } else if (folded.has(b.id)) {
        content = `[Earlier result folded to save context — ${b.digest}. Your own notes from that point are still above; call the tool again only if you truly need the rows.]`;
      } else {
        content = b.output;
      }
      results.push({ type: "tool_result", id: b.id, name: b.name, content });
    }
    push("assistant", calls);
    push("user", results);
  }
  return out;
}
