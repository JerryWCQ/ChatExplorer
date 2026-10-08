/**
 * AI organizer, pure layer: handles, scope, tools, the batch planner, message
 * building and rewind planning. No IndexedDB, no network — snapshots in,
 * text and ops out. The planner is the part that must never be wrong: it is
 * where untrusted model output turns into writes.
 */

import { expect, test } from "vitest";
import { ROOT_ID, UNFILED_ID, type Chat, type Folder } from "../core/schema";
import type { Snapshot } from "../core/store";
import { translator } from "../ui/i18n";
import { summaryHead } from "../ui/markdown";
import { buildMessages } from "./context";
import { IdRegistry } from "./ids";
import { systemPrompt } from "./prompt";
import { planRewind, rewindStatus, stepState } from "./rewind";
import { resolveAccess } from "./scope";
import { describeOutcome, planChanges, runReadTool, searchMatcher, type ToolEnv } from "./tools";
import type { AgentScope, ToolBlock, Turn } from "./types";

const t = translator("en");

function folder(id: string, parentId: string | null, name: string, hidden = false): Folder {
  return { id, parentId, name, createdAt: 0, hidden, pos: null };
}

function chat(uuid: string, patch: Partial<Chat> = {}): Chat {
  return {
    uuid,
    folderId: UNFILED_ID,
    displayName: null,
    remoteName: `chat ${uuid}`,
    summary: "",
    model: "claude-sonnet-4-5",
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-02T00:00:00",
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
    pos: null,
    ...patch
  };
}

/**
 *   root
 *   ├─ unfiled   u1 u2 u3
 *   ├─ work      w1
 *   │  └─ tax    x1
 *   ├─ home      h1
 *   └─ bin (hidden)  b1
 */
function library(): Snapshot {
  return {
    folders: [
      folder(ROOT_ID, null, "Folders"),
      folder(UNFILED_ID, ROOT_ID, "Unfiled"),
      folder("work", ROOT_ID, "Work"),
      folder("tax", "work", "Tax"),
      folder("home", ROOT_ID, "Home"),
      folder("bin", ROOT_ID, "Old", true)
    ],
    chats: [
      chat("u1", { remoteName: "Python decorators", summary: "**Conversation Overview** How decorators wrap functions.\n\n**Details**\n- more" }),
      chat("u2", { remoteName: "Trip to Kyoto", updatedAt: "2026-02-01T00:00:00" }),
      chat("u3", { remoteName: "", summary: "Budget planning for 2026. Lots more text." }),
      chat("w1", { folderId: "work", remoteName: "Quarterly report" }),
      chat("x1", { folderId: "tax", remoteName: "Deductions" }),
      chat("h1", { folderId: "home", remoteName: "Garden" }),
      chat("b1", { folderId: "bin", remoteName: "Deleted thing" })
    ],
    shortcuts: [],
    stacks: []
  };
}

function env(scope: AgentScope, snap = library(), ids = new IdRegistry()): ToolEnv {
  return { snap, access: resolveAccess(scope, snap), ids, lang: "en", t };
}

const ALL: AgentScope = { kind: "all" };

// --- handles ------------------------------------------------------------------

test("handles are handed out lazily, never reused, and survive a round trip", () => {
  const ids = new IdRegistry();
  expect(ids.chat("aaa")).toBe("c1");
  expect(ids.chat("bbb")).toBe("c2");
  expect(ids.chat("aaa")).toBe("c1");
  expect(ids.folder(ROOT_ID)).toBe("root");
  expect(ids.folder("work")).toBe("f1");

  const back = new IdRegistry(JSON.parse(JSON.stringify(ids.toJSON())));
  expect(back.chat("ccc")).toBe("c3");
  expect(back.resolveChat("c2")).toBe("bbb");
  // Models write handles back sloppily; the raw id also resolves.
  expect(back.resolveChat(" C1 ")).toBe("aaa");
  expect(back.resolveChat("aaa")).toBe("aaa");
  expect(back.resolveChat("c99")).toBeNull();
  expect(back.resolveFolder("root")).toBe(ROOT_ID);
  expect(back.resolveFolder("f1")).toBe("work");
});

// --- scope --------------------------------------------------------------------

test("blank space: everything visible, the bin excluded", () => {
  const snap = library();
  const a = resolveAccess(ALL, snap);
  const byId = (id: string) => snap.chats.find((c) => c.uuid === id)!;
  expect(a.canWriteChat(byId("u1"))).toBe(true);
  expect(a.canWriteChat(byId("b1"))).toBe(false);
  expect(a.canMoveInto("bin")).toBe(false);
  expect(a.canEditFolder(UNFILED_ID)).toBe(false);
  expect(a.canEditFolder("work")).toBe(true);
});

test("folders: read and write only inside the subtrees", () => {
  const snap = library();
  const a = resolveAccess({ kind: "items", folderIds: ["work"], chatUuids: ["u2"] }, snap);
  const byId = (id: string) => snap.chats.find((c) => c.uuid === id)!;
  expect(a.mode).toBe("folders");
  expect(a.canWriteChat(byId("x1"))).toBe(true);
  expect(a.canWriteChat(byId("u2"))).toBe(true); // selected alongside
  expect(a.canWriteChat(byId("u1"))).toBe(false);
  expect(a.canReadChat(byId("h1"))).toBe(false);
  expect(a.canMoveInto("tax")).toBe(true);
  expect(a.canMoveInto("home")).toBe(false);
  expect(a.canEditFolder("work")).toBe(true);
});

test("only chats: read everything, write only those, file them anywhere", () => {
  const snap = library();
  const a = resolveAccess({ kind: "items", folderIds: [], chatUuids: ["u1"] }, snap);
  const byId = (id: string) => snap.chats.find((c) => c.uuid === id)!;
  expect(a.mode).toBe("chats");
  expect(a.canReadChat(byId("h1"))).toBe(true);
  expect(a.canWriteChat(byId("h1"))).toBe(false);
  expect(a.canWriteChat(byId("u1"))).toBe(true);
  expect(a.canMoveInto("home")).toBe(true);
  expect(a.canCreateIn("home")).toBe(true);
  expect(a.canEditFolder("home")).toBe(false);
});

// --- read tools ---------------------------------------------------------------

test("summaryHead keeps the overview paragraph and drops the label", () => {
  const md = "**Conversation Overview** How decorators wrap functions.\n\n**Details**\n- more";
  expect(summaryHead(md, 200)).toBe("How decorators wrap functions.");
  expect(summaryHead(md, 10)).toBe("How decora…");
  expect(summaryHead("", 50)).toBe("");
});

test("list_chats pages, prints handles, and includes openings on request", () => {
  const e = env(ALL);
  const page = runReadTool("list_chats", { limit: 2 }, e);
  expect(page.output).toMatch(/1–2 of 6 \(next page: offset=2\)/);
  // Newest first, and the bin's chat is not among the 6.
  expect(page.output).toMatch(/c1 \| 2026-02-01 \| Sonnet 4\.5 \| f\d+ \| Trip to Kyoto/);
  expect(page.output).not.toMatch(/Deleted thing/);

  const heads = runReadTool("list_chats", { folder: "root", recursive: true, summary_chars: 100 }, e);
  expect(heads.output).toMatch(/Python decorators \| How decorators wrap functions\./);
  expect(heads.output).toMatch(/\(no summary\)/);
  expect(heads.digest).toMatch(/^list_chats/);
});

test("in only-chats mode the rest of the library is marked read-only", () => {
  const e = env({ kind: "items", folderIds: [], chatUuids: ["u1"] });
  const out = runReadTool("list_chats", { folder: "root", recursive: true }, e).output;
  expect(out).toMatch(/Garden \| read-only/);
  expect(out).not.toMatch(/Python decorators \| read-only/);
});

test("the overview tree shows handles, counts, and marks what may not change", () => {
  const e = env({ kind: "items", folderIds: ["work"], chatUuids: [] });
  const out = runReadTool("get_overview", {}, e).output;
  expect(out).toMatch(/f1 Work \(1 \/ 2\)/);
  expect(out).toMatch(/ {2}f2 Tax \(1 \/ 1\)/);
  expect(out).not.toMatch(/Home/);
  // A folder outside the scope cannot be listed.
  expect(runReadTool("list_chats", { folder: "root" }, e).output).toMatch(/^Error/);
});

test("search: alternatives with | or OR, whole-word English, anywhere-Chinese (user report)", () => {
  // The two failures from a real session: "code OR 编程 OR python" found 0,
  // and "SAT" / "AP" matched inside unrelated English words.
  const any = searchMatcher("code OR 编程 OR python");
  expect(any("学习编程的第一天")).toBe(true);
  expect(any("A Python question")).toBe(true);
  expect(any("nothing relevant")).toBe(false);

  const sat = searchMatcher("SAT");
  expect(sat("SAT 模考第三套")).toBe(true);
  expect(sat("sat math, section 2")).toBe(true);
  expect(sat("How to satisfy the constraint")).toBe(false);
  expect(sat("Saturday plans")).toBe(false);
  expect(searchMatcher("AP")("the app approach")).toBe(false);
  expect(searchMatcher("AP")("AP 微积分")).toBe(true);
  // Full-width Latin still matches (the app-wide normalisation applies).
  expect(searchMatcher("股票|美股")("聊聊美股")).toBe(true);
  expect(searchMatcher("c++")("learning C++ templates")).toBe(true);
});

test("search lists title matches before body matches", () => {
  const snap = library();
  snap.chats[3] = { ...snap.chats[3]!, summary: "About Kyoto temples." }; // w1, body match
  const out = runReadTool("search_chats", { query: "kyoto", summary_chars: 0 }, env(ALL, snap)).output;
  expect(out).toMatch(/2 chats match "kyoto" \(1 in the title\)/);
  expect(out.indexOf("Trip to Kyoto")).toBeLessThan(out.indexOf("Quarterly report"));
});

test("a titles-only page may run to 500 rows; with summaries it stays at 200", () => {
  const snap = library();
  snap.chats = Array.from({ length: 600 }, (_, i) =>
    chat(`k${i}`, { remoteName: `t${i}`, updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}` })
  );
  expect(runReadTool("list_chats", { limit: 999 }, env(ALL, snap)).output).toMatch(/1–500 of 600/);
  expect(runReadTool("list_chats", { limit: 999, summary_chars: 50 }, env(ALL, snap)).output).toMatch(/1–200 of 600/);
});

// --- the planner --------------------------------------------------------------

test("one batch can create a folder and file chats into it through a ref", () => {
  const e = env(ALL);
  runReadTool("list_chats", {}, e); // hands out c1…c6
  const u1 = e.ids.chat("u1");
  const u2 = e.ids.chat("u2");
  const plan = planChanges(
    {
      summary: "File travel",
      actions: [
        { type: "create_folder", name: "Travel", parent: "root", ref: "t" },
        { type: "move_chats", ids: [u1, u2], to: "t" }
      ]
    },
    e
  );
  expect(plan.errors).toEqual([]);
  expect(plan.ops[0]).toMatchObject({ t: "folder.put" });
  const newId = plan.created[0]!.id;
  expect(plan.ops.slice(1)).toEqual([
    { t: "chat.patch", uuid: "u1", patch: { folderId: newId } },
    { t: "chat.patch", uuid: "u2", patch: { folderId: newId } }
  ]);
  expect(plan.preview.map((l) => l.key)).toEqual(["aiPvCreateFolder", "aiPvMove"]);
  expect(plan.touched).toContain("chat:u1");
  expect(describeOutcome(plan, e.ids, true)).toMatch(/Created folder f\d+ "Travel" \(ref t\)/);
});

test("a bad handle is refused and reported; the rest of the batch still applies", () => {
  const e = env(ALL);
  const u1 = e.ids.chat("u1");
  const home = e.ids.folder("home");
  const plan = planChanges(
    { summary: "x", actions: [{ type: "move_chats", ids: [u1, "c404"], to: home }, { type: "explode" }] },
    e
  );
  expect(plan.ops).toEqual([{ t: "chat.patch", uuid: "u1", patch: { folderId: "home" } }]);
  expect(plan.errors.map((l) => l.key)).toEqual(["aiErrChats", "aiErrAction"]);
  expect(plan.modelErrors.join("\n")).toMatch(/c404/);
});

test("folder scope: moves must land inside; chats outside cannot be touched", () => {
  const e = env({ kind: "items", folderIds: ["work"], chatUuids: [] });
  const x1 = e.ids.chat("x1");
  const u1 = e.ids.chat("u1");
  const out = planChanges({ summary: "x", actions: [{ type: "move_chats", ids: [x1], to: e.ids.folder("home") }] }, e);
  expect(out.ops).toEqual([]);
  expect(out.errors[0]?.key).toBe("aiErrFolder");

  const inside = planChanges(
    { summary: "x", actions: [{ type: "move_chats", ids: [x1, u1], to: e.ids.folder("work") }] },
    e
  );
  expect(inside.ops).toEqual([{ t: "chat.patch", uuid: "x1", patch: { folderId: "work" } }]);
  expect(inside.errors[0]?.key).toBe("aiErrChats");
});

test("only-chats scope: file anywhere, even a new folder, but leave folders alone", () => {
  const e = env({ kind: "items", folderIds: [], chatUuids: ["u1"] });
  const u1 = e.ids.chat("u1");
  const plan = planChanges(
    {
      summary: "x",
      actions: [
        { type: "create_folder", name: "Code", parent: e.ids.folder("home"), ref: "c" },
        { type: "move_chats", ids: [u1], to: "c" },
        { type: "rename", id: e.ids.folder("home"), name: "House" },
        { type: "move_chats", ids: [e.ids.chat("h1")], to: "c" }
      ]
    },
    e
  );
  expect(plan.preview.map((l) => l.key)).toEqual(["aiPvCreateFolder", "aiPvMove"]);
  expect(plan.errors.map((l) => l.key)).toEqual(["aiErrFolder", "aiErrChats"]);
});

test("permission is judged on the original record, not the mid-batch position", () => {
  // Folder scope: a chat moved into a folder created in this batch is still
  // the user's chat — renaming it in the same batch must not be refused.
  const e = env({ kind: "items", folderIds: ["work"], chatUuids: [] });
  const w1 = e.ids.chat("w1");
  const plan = planChanges(
    {
      summary: "x",
      actions: [
        { type: "create_folder", name: "Reports", parent: e.ids.folder("work"), ref: "r" },
        { type: "move_chats", ids: [w1], to: "r" },
        { type: "rename", id: w1, name: "Q3 report" }
      ]
    },
    e
  );
  expect(plan.errors).toEqual([]);
  expect(plan.ops.at(-1)).toEqual({ t: "chat.patch", uuid: "w1", patch: { displayName: "Q3 report" } });
});

test("renaming a chat to its claude.ai title clears the alias instead of storing it", () => {
  const snap = library();
  snap.chats[0] = { ...snap.chats[0]!, displayName: "Decorators!" };
  const e = env(ALL, snap);
  const plan = planChanges({ summary: "x", actions: [{ type: "rename", id: e.ids.chat("u1"), name: "Python decorators" }] }, e);
  expect(plan.ops).toEqual([{ t: "chat.patch", uuid: "u1", patch: { displayName: null } }]);
  expect(plan.preview[0]?.key).toBe("aiPvResetName");
});

test("delete is soft, flags the batch, and never touches system folders", () => {
  const e = env(ALL);
  const plan = planChanges(
    { summary: "x", actions: [{ type: "delete", ids: [e.ids.chat("u3"), e.ids.folder("home"), e.ids.folder(UNFILED_ID)] }] },
    e
  );
  expect(plan.hasDelete).toBe(true);
  expect(plan.ops).toEqual([
    { t: "chat.patch", uuid: "u3", patch: { hidden: true } },
    { t: "folder.put", folder: expect.objectContaining({ id: "home", hidden: true }) }
  ]);
  expect(plan.errors.map((l) => l.key)).toEqual(["aiErrFolder"]);
});

test("a folder cannot move into its own subtree", () => {
  const e = env(ALL);
  const plan = planChanges({ summary: "x", actions: [{ type: "move_folder", id: e.ids.folder("work"), to: e.ids.folder("tax") }] }, e);
  expect(plan.ops).toEqual([]);
  expect(plan.errors[0]?.key).toBe("aiErrCycle");
});

test("a stack forms from chats gathered earlier in the same batch", () => {
  const e = env(ALL);
  const [a, b] = [e.ids.chat("u1"), e.ids.chat("h1")];
  const refused = planChanges({ summary: "x", actions: [{ type: "create_stack", ids: [a, b] }] }, e);
  expect(refused.errors[0]?.key).toBe("aiErrStack");

  const plan = planChanges(
    {
      summary: "x",
      actions: [
        { type: "move_chats", ids: [a], to: e.ids.folder("home") },
        { type: "create_stack", ids: [a, b], name: "Mixed" }
      ]
    },
    e
  );
  expect(plan.errors).toEqual([]);
  expect(plan.ops.at(-1)).toMatchObject({
    t: "stack.put",
    stack: { folderId: "home", name: "Mixed", members: ["chat:u1", "chat:h1"] }
  });
});

// --- prompt -------------------------------------------------------------------

test("the prompt carries standing preferences only when there are some", () => {
  const base = { scope: ALL, folders: library().folders, autoApply: true, now: 0 };
  const without = systemPrompt(base);
  expect(without).not.toContain("<preferences>");
  const withPrefs = systemPrompt({ ...base, preferences: "- 按项目分" });
  expect(withPrefs).toContain("<preferences>\n- 按项目分\n</preferences>");
  // Preferences come before the defaults they override.
  expect(withPrefs.indexOf("<preferences>")).toBeLessThan(withPrefs.indexOf("Follow the existing structure"));
  expect(without).toMatch(/No emoji/);
});

// --- messages -----------------------------------------------------------------

function tool(id: string, name: string, output?: string, extra: Partial<ToolBlock> = {}): ToolBlock {
  return { type: "tool", id, name, rawInput: "{}", input: {}, status: "done", output, digest: `${name} digest`, ...extra };
}
function turn(idx: number, role: Turn["role"], blocks: Turn["blocks"]): Turn {
  return { sessionId: "s", idx, role, blocks, ts: 0 };
}

test("tool blocks split into call and result, and an unanswered call still gets a result", () => {
  const msgs = buildMessages([
    turn(0, "user", [{ type: "text", text: "tidy up" }]),
    turn(1, "assistant", [{ type: "text", text: "Looking." }, tool("a", "get_overview", "tree"), tool("b", "list_chats")])
  ]);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(msgs[1]!.parts.map((p) => p.type)).toEqual(["text", "tool_call", "tool_call"]);
  const results = msgs[2]!.parts;
  expect(results[0]).toMatchObject({ type: "tool_result", id: "a", content: "tree" });
  expect(results[1]).toMatchObject({ type: "tool_result", id: "b", content: expect.stringMatching(/Not executed/) });
});

test("reads fold only past the budget, oldest first; the newest overview and all writes stay", () => {
  const turns: Turn[] = [turn(0, "user", [{ type: "text", text: "go" }])];
  turns.push(turn(1, "assistant", [tool("ov", "get_overview", "TREE")]));
  turns.push(turn(2, "assistant", [tool("l1", "list_chats", "PAGE1"), tool("w1", "apply_changes", "APPLIED")]));
  for (let i = 3; i <= 5; i++) turns.push(turn(i, "assistant", [tool(`l${i}`, "list_chats", `PAGE${i}`)]));

  // Default budget: a small session keeps everything — no reason to re-read.
  const whole = JSON.stringify(buildMessages(turns));
  for (const s of ["PAGE1", "PAGE3", "PAGE5"]) expect(whole).toContain(s);

  // A budget of two pages keeps the two newest; older reads fold to digests.
  const tight = JSON.stringify(buildMessages(turns, 10));
  expect(tight).toContain("PAGE5");
  expect(tight).toContain("PAGE4");
  expect(tight).not.toContain("PAGE3");
  expect(tight).not.toContain("PAGE1");
  expect(tight).toContain("list_chats digest");
  expect(tight).toContain("TREE");
  expect(tight).toContain("APPLIED");
});

test("a user message right after tool results merges into one user message", () => {
  const msgs = buildMessages([
    turn(0, "user", [{ type: "text", text: "go" }]),
    turn(1, "assistant", [tool("a", "list_chats", "x")]),
    turn(2, "user", [{ type: "text", text: "stop, do it differently" }])
  ]);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(msgs[2]!.parts.map((p) => p.type)).toEqual(["tool_result", "text"]);
});

// --- rewind -------------------------------------------------------------------

function session(): Turn[] {
  return [
    turn(0, "user", [{ type: "text", text: "file my chats" }]),
    turn(1, "assistant", [tool("r", "list_chats", "x"), tool("w1", "apply_changes", "ok", { seq: 10 })]),
    turn(2, "assistant", [{ type: "text", text: "Next batch." }, tool("w2", "apply_changes", "ok", { seq: 12 })]),
    turn(3, "user", [{ type: "text", text: "now the rest" }]),
    turn(4, "assistant", [tool("w3", "apply_changes", "ok", { seq: 13 })])
  ];
}

test("rewinding to a user message undoes from its first batch and gives the text back", () => {
  const plan = planRewind(session(), { turnIdx: 3, blockIdx: null });
  expect(plan.keep.map((t) => t.idx)).toEqual([0, 1, 2]);
  expect(plan.dropFrom).toBe(3);
  expect(plan.anchor).toBe(13);
  expect(plan.restoreText).toBe("now the rest");
});

test("rewinding to a batch cuts the turn just before it", () => {
  const plan = planRewind(session(), { turnIdx: 2, blockIdx: 1 });
  expect(plan.keep.at(-1)!.blocks).toEqual([{ type: "text", text: "Next batch." }]);
  expect(plan.dropFrom).toBe(3);
  expect(plan.steps).toEqual([12, 13]);
  expect(plan.anchor).toBe(12);
  expect(plan.restoreText).toBeNull();
});

test("rewind status counts the user's own edits caught in between, and knows lost steps", () => {
  const plan = planRewind(session(), { turnIdx: 2, blockIdx: 1 });
  // Log: 10 (agent), 11 (manual), 12 (agent), 13 (agent), 14 (manual); cursor at 14.
  const log = { seqs: [10, 11, 12, 13, 14], cursor: 14 };
  expect(rewindStatus(plan, log, new Set([10, 12, 13]))).toEqual({ ok: true, undo: 3, manual: 1 });
  expect(rewindStatus(plan, { seqs: [13, 14], cursor: 14 }, new Set())).toEqual({ ok: false });
  expect(stepState(12, log)).toBe("applied");
  expect(stepState(12, { seqs: log.seqs, cursor: 11 })).toBe("undone");
  expect(stepState(9, log)).toBe("gone");
});
