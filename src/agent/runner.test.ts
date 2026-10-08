/**
 * The agent loop end to end, against a scripted fake API and a real (fake-
 * indexeddb) database: tool calls run, batches commit as single undo steps,
 * approval gates hold, conversations persist, and rewind restores both the
 * library and the conversation.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { idb, tx } from "../core/db";
import { logIndex } from "../core/ops";
import { ROOT_ID, STORE, UNFILED_ID, type Chat } from "../core/schema";
import { snapshot } from "../core/store";
import { translator } from "../ui/i18n";
import { AgentRunner, newSession } from "./runner";
import { loadAiConfig } from "./config";
import { loadTurns } from "./sessions";
import { DEFAULT_AI_CONFIG, type AiConfig, type ToolBlock } from "./types";

const t = translator("en");

function fakeChat(uuid: string, updatedAt: string): Chat {
  return {
    uuid,
    folderId: UNFILED_ID,
    displayName: null,
    remoteName: `chat ${uuid}`,
    summary: "",
    model: "claude-sonnet-4-5",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    isStarred: false,
    isTemporary: false,
    projectUuid: null,
    lastReadAt: null,
    status: "active",
    firstSeenAt: 0,
    lastSyncedAt: 0,
    notes: "",
    flagged: false,
    hidden: false,
    pos: null
  };
}

beforeEach(async () => {
  const stores = [STORE.folders, STORE.chats, STORE.shortcuts, STORE.stacks, STORE.transactions, STORE.meta, STORE.agentSessions, STORE.agentTurns];
  await tx(stores, "readwrite", async (t) => {
    for (const s of stores) if (s !== STORE.folders) t.objectStore(s).clear();
    for (const f of await idb.getAll<{ id: string }>(t, STORE.folders)) {
      if (f.id !== ROOT_ID && f.id !== UNFILED_ID) await idb.del(t, STORE.folders, f.id);
    }
    await idb.put(t, STORE.chats, fakeChat("aaa", "2026-03-02T00:00:00Z")); // newest → c1
    await idb.put(t, STORE.chats, fakeChat("bbb", "2026-03-01T00:00:00Z")); // → c2
  });
});

afterEach(() => vi.unstubAllGlobals());

// --- a scripted Anthropic-format API ------------------------------------------------

type Reply = { text?: string; tools?: { name: string; input: unknown }[] };

function sseFor(reply: Reply, n: number): string {
  const ev = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  let out = ev({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
  let index = 0;
  if (reply.text) {
    out += ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    out += ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } });
    index++;
  }
  for (const [i, tool] of (reply.tools ?? []).entries()) {
    out += ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: `t${n}_${i}`, name: tool.name, input: {} } });
    out += ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
    index++;
  }
  out += ev({ type: "message_delta", delta: { stop_reason: reply.tools?.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
  return out;
}

function scriptApi(replies: Reply[]) {
  const bodies: { messages: { role: string; content: { type: string; content?: string }[] }[] }[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const reply = replies[n] ?? { text: "(script exhausted)" };
      const body = sseFor(reply, n++);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    })
  );
  return bodies;
}

const cfg: AiConfig = { ...DEFAULT_AI_CONFIG, apiKey: "k", model: "m", autoApply: true };

function runner(config: AiConfig = cfg, onChange = () => {}) {
  return new AgentRunner(newSession({ kind: "all" }), [], {
    config,
    lang: "en",
    t,
    onChange,
    onCommitted: () => {}
  });
}

const FILE_BOTH = {
  name: "apply_changes",
  input: {
    summary: "File both",
    actions: [
      { type: "create_folder", name: "Work", parent: "root", ref: "w" },
      { type: "move_chats", ids: ["c1", "c2"], to: "w" }
    ]
  }
};

test("read, then a batch, then an answer: one undo step, persisted, results fed back", async () => {
  const bodies = scriptApi([
    { text: "Looking.", tools: [{ name: "list_chats", input: {} }] },
    { tools: [FILE_BOTH] },
    { text: "Done: filed 2 chats into Work." }
  ]);
  const r = runner();
  await r.send("file my chats");

  expect(bodies).toHaveLength(3);
  // Round 2 saw round 1's tool result.
  const second = bodies[1]!.messages;
  expect(second.at(-1)!.content[0]).toMatchObject({ type: "tool_result" });
  expect(String(second.at(-1)!.content[0]!.content)).toMatch(/c1 \| .* \| chat aaa/);

  const snap = await snapshot();
  const work = snap.folders.find((f) => f.name === "Work")!;
  expect(snap.chats.every((c) => c.folderId === work.id)).toBe(true);

  const batch = r.turns[2]!.blocks[0] as ToolBlock;
  expect(batch.status).toBe("done");
  const { seqs } = await logIndex();
  expect(seqs).toEqual([batch.seq]); // the whole batch is ONE step
  expect(r.session.steps).toEqual([batch.seq]);
  expect(batch.output).toMatch(/Created folder f\d+ "Work"/);

  const stored = await loadTurns(r.session.id);
  expect(stored.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  expect(r.session.title).toBe("file my chats");
  expect(r.session.usage.output).toBe(15);
  expect(r.running).toBe(false);
});

test("rewinding to the user message restores the library and hands the text back", async () => {
  // Handles are minted by reading, so the script reads first, as a real session would.
  scriptApi([{ tools: [{ name: "list_chats", input: {} }] }, { tools: [FILE_BOTH] }, { text: "Done." }]);
  const r = runner();
  await r.send("file my chats");
  expect((await snapshot()).folders.some((f) => f.name === "Work")).toBe(true);

  const result = await r.rewind({ turnIdx: 0, blockIdx: null });
  expect(result).toEqual({ restoreText: "file my chats" });
  const snap = await snapshot();
  expect(snap.folders.some((f) => f.name === "Work")).toBe(false);
  expect(snap.chats.every((c) => c.folderId === UNFILED_ID)).toBe(true);
  expect(r.turns).toEqual([]);
  expect(await loadTurns(r.session.id)).toEqual([]);
});

test("with auto-apply off a batch waits; rejecting writes nothing and tells the model", async () => {
  const bodies = scriptApi([{ tools: [{ name: "list_chats", input: {} }] }, { tools: [FILE_BOTH] }, { text: "OK, what instead?" }]);
  let r!: AgentRunner;
  r = runner({ ...cfg, autoApply: false }, () => {
    if (r?.awaiting) r.decide(false);
  });
  await r.send("file my chats");

  const batch = r.turns[2]!.blocks[0] as ToolBlock;
  expect(batch.status).toBe("rejected");
  expect(batch.preview?.length).toBe(2);
  expect((await logIndex()).seqs).toEqual([]);
  expect(String(bodies[2]!.messages.at(-1)!.content[0]!.content)).toMatch(/rejected/);
});

test("a delete waits for approval even with auto-apply on", async () => {
  scriptApi([
    { tools: [{ name: "list_chats", input: {} }] },
    { tools: [{ name: "apply_changes", input: { summary: "Delete c2", actions: [{ type: "delete", ids: ["c2"] }] } }] },
    { text: "Deleted." }
  ]);
  let asked = 0;
  let r!: AgentRunner;
  r = runner(cfg, () => {
    if (r?.awaiting) {
      asked++;
      r.decide(true);
    }
  });
  await r.send("delete chat bbb");
  expect(asked).toBe(1);
  expect((await snapshot()).chats.find((c) => c.uuid === "bbb")?.hidden).toBe(true);
});

test("stopping while a batch awaits approval ends the run cleanly", async () => {
  const bodies = scriptApi([{ tools: [{ name: "list_chats", input: {} }] }, { tools: [FILE_BOTH] }, { text: "never sent" }]);
  let r!: AgentRunner;
  r = runner({ ...cfg, autoApply: false }, () => {
    if (r?.awaiting) r.stop();
  });
  await r.send("file my chats");
  expect(bodies).toHaveLength(2);
  expect((r.turns[2]!.blocks[0] as ToolBlock).status).toBe("rejected");
  expect(r.turns[2]!.stop).toBe("aborted");
  expect(r.running).toBe(false);
});

test("an HTTP error ends the turn with a readable error instead of throwing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }))
  );
  const r = runner();
  await r.send("hello");
  const turn = r.turns[1]!;
  expect(turn.stop).toBe("error");
  expect(turn.errorKind).toBe("auth");
  expect(turn.error).toMatch(/invalid x-api-key/);
});

test("retry after an error drops the failed empty reply and answers afresh", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const r = runner();
  await r.send("hello");
  expect(r.turns.map((t) => t.stop)).toEqual([undefined, "error"]);

  const bodies = scriptApi([{ text: "Hi." }]);
  await r.resume();
  expect(r.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(r.turns[1]!.blocks).toEqual([{ type: "text", text: "Hi." }]);
  // The failed turn is gone from storage too, not just from memory.
  expect((await loadTurns(r.session.id)).length).toBe(2);
  expect(bodies[0]!.messages.map((m) => m.role)).toEqual(["user"]);
});

test("remember_preference always asks, saves on approval, and skips a duplicate", async () => {
  const pref = { name: "remember_preference", input: { text: "文件夹按项目分" } };
  const bodies = scriptApi([{ tools: [pref] }, { tools: [pref] }, { text: "OK" }]);
  let asked = 0;
  let r!: AgentRunner;
  r = runner(cfg, () => {
    if (r?.awaiting) {
      asked++;
      r.decide(true);
    }
  });
  await r.send("以后按项目分");

  expect(asked).toBe(1); // auto-apply is on, and it still asked — once
  expect((await loadAiConfig()).preferences).toBe("- 文件夹按项目分");
  expect((r.turns[2]!.blocks[0] as ToolBlock).output).toMatch(/Already in/);
  // The request after the save already carries the preference.
  expect(JSON.stringify(bodies[1])).toContain("文件夹按项目分");
});

test("a declined preference is not saved", async () => {
  scriptApi([{ tools: [{ name: "remember_preference", input: { text: "不要叠放" } }] }, { text: "OK" }]);
  let r!: AgentRunner;
  r = runner(cfg, () => {
    if (r?.awaiting) r.decide(false);
  });
  await r.send("x");
  expect((await loadAiConfig()).preferences).toBe("");
  expect((r.turns[1]!.blocks[0] as ToolBlock).status).toBe("rejected");
});

test("the round limit stops a model that never stops calling tools", async () => {
  const bodies = scriptApi(Array.from({ length: 10 }, () => ({ tools: [{ name: "get_overview", input: {} }] })));
  const r = runner({ ...cfg, maxRounds: 3 });
  await r.send("go");
  expect(bodies).toHaveLength(3);
  expect(r.turns.at(-1)!.stop).toBe("round_limit");
});
