import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { idb, tx } from "./db";
import { commit, historyLog, historyState, jumpBefore, jumpTo, logIndex, redo, undo } from "./ops";
import { ROOT_ID, STORE, UNFILED_ID, type Chat } from "./schema";
import {
  createFolder,
  createShortcuts,
  deleteShortcuts,
  folderPath,
  hiddenFolderIds,
  isChatHidden,
  moveChats,
  moveFolder,
  purgeRefs,
  renameChat,
  restoreRefs,
  renameFolder,
  setChatsFlagged,
  setChatsHidden,
  setFolderHidden,
  snapshot
} from "./store";
import { extractUuid, locate } from "./locate";

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";

function fakeChat(uuid: string): Chat {
  return {
    uuid,
    folderId: UNFILED_ID,
    displayName: null,
    remoteName: `chat ${uuid.slice(0, 4)}`,
    summary: "",
    model: "claude-opus-5",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
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
  await tx(
    [STORE.folders, STORE.chats, STORE.shortcuts, STORE.transactions, STORE.meta],
    "readwrite",
    async (t) => {
      for (const store of [STORE.chats, STORE.shortcuts, STORE.transactions, STORE.meta]) {
        t.objectStore(store).clear();
      }
      const folders = await idb.getAll<{ id: string }>(t, STORE.folders);
      for (const f of folders) {
        if (f.id !== ROOT_ID && f.id !== UNFILED_ID) await idb.del(t, STORE.folders, f.id);
      }
      await idb.put(t, STORE.chats, fakeChat(CHAT_A));
      await idb.put(t, STORE.chats, fakeChat(CHAT_B));
    }
  );
});

test("moving a chat is undoable and redoable", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([CHAT_A], work);

  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(work);

  await undo();
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(UNFILED_ID);

  await redo();
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(work);
});

test("the history log names every step and marks how far along it you are", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([CHAT_A, CHAT_B], work);

  const log = await historyLog();
  expect(log.entries).toHaveLength(2);
  // Oldest first, so the list reads in the order things happened.
  expect(log.entries[0]?.label.key).toBe("opNewFolder");
  expect(log.entries[1]?.label).toEqual({ key: "opMoveChats", vars: { n: 2 } });
  // Two chats moved = two primitive writes, which is what the panel counts.
  expect(log.entries[1]?.size).toBe(2);
  // The cursor sits on the newest step, because everything is applied.
  expect(log.cursor).toBe(log.entries[1]?.seq);
});

test("jumping winds the log both ways and lands exactly where it left", async () => {
  const a = await createFolder(ROOT_ID, "A");
  await moveChats([CHAT_A], a);
  const b = await createFolder(ROOT_ID, "B");
  await moveChats([CHAT_A], b);

  const log = await historyLog();
  const afterFirstMove = log.entries[1]?.seq ?? 0;
  const newest = log.cursor;

  // Winding back reports how many steps it undid, and the state is the one
  // that existed right after the step jumped to — 「回到某个动作之前」.
  expect(await jumpTo(afterFirstMove)).toBe(-2);
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(a);
  expect((await snapshot()).folders.some((f) => f.id === b)).toBe(false);

  // …and winding forward again is the same move in reverse — 「取消回退」.
  expect(await jumpTo(newest)).toBe(2);
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(b);

  // Nothing was appended on the way: the round trip is invisible to the log.
  expect((await historyLog()).entries).toHaveLength(4);
});

test("jumping to 0 winds all the way back, and an unknown seq is refused", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([CHAT_A], work);

  expect(await jumpTo(0)).toBe(-2);
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(UNFILED_ID);
  expect((await historyLog()).cursor).toBe(0);

  // A seq no entry describes would strand the cursor somewhere undo cannot
  // reason from, so it is a no-op rather than a best guess.
  expect(await jumpTo(9999)).toBe(0);
  expect((await historyLog()).cursor).toBe(0);
});

test("jumpBefore lands just before a step, across manual steps in between", async () => {
  const a = await createFolder(ROOT_ID, "A"); // step 1
  await moveChats([CHAT_A], a); // step 2 — "the agent's batch"
  await moveChats([CHAT_B], a); // step 3 — "a manual edit after it"

  const { seqs } = await logIndex();
  const batch = seqs[1]!;
  // Winding to before step 2 undoes it and everything after — both moves.
  expect(await jumpBefore(batch)).toBe(-2);
  const s = await snapshot();
  expect(s.chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(UNFILED_ID);
  expect(s.chats.find((c) => c.uuid === CHAT_B)?.folderId).toBe(UNFILED_ID);
  expect(s.folders.some((f) => f.id === a)).toBe(true);
  expect((await logIndex()).cursor).toBe(seqs[0]);
});

test("jumpBefore the oldest step winds to zero, and a vanished step is refused", async () => {
  await createFolder(ROOT_ID, "A");
  const { seqs } = await logIndex();
  expect(await jumpBefore(seqs[0]!)).toBe(-1);
  expect((await logIndex()).cursor).toBe(0);
  // A step that is not in the log cannot be rewound to — null, not a guess.
  expect(await jumpBefore(9999)).toBeNull();
});

test("commit returns the seq of the step it wrote, and 0 for an empty batch", async () => {
  const folder = { id: "x", parentId: ROOT_ID, name: "X", createdAt: 0, hidden: false, pos: null };
  const seq = await commit({ key: "opLegacy" }, [{ t: "folder.put", folder }]);
  const { seqs, cursor } = await logIndex();
  expect(seqs).toEqual([seq]);
  expect(cursor).toBe(seq);
  expect(await commit({ key: "opLegacy" }, [])).toBe(0);
});

test("a new action clears the redo branch", async () => {
  const a = await createFolder(ROOT_ID, "A");
  await moveChats([CHAT_A], a);
  await undo();

  expect((await historyState()).redoLabel).not.toBeNull();
  await createFolder(ROOT_ID, "B");
  expect((await historyState()).redoLabel).toBeNull();
});

test("deleting a folder hides the whole subtree without re-filing anything", async () => {
  const outer = await createFolder(ROOT_ID, "Outer");
  const inner = await createFolder(outer, "Inner");
  await moveChats([CHAT_A], inner);

  await setFolderHidden(outer, true);
  let data = await snapshot();
  let hidden = hiddenFolderIds(data.folders);
  expect(hidden.has(outer)).toBe(true);
  expect(hidden.has(inner)).toBe(true);
  // Structure is untouched: the chat is still where the user put it.
  expect(data.chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(inner);
  expect(isChatHidden(data.chats.find((c) => c.uuid === CHAT_A)!, hidden)).toBe(true);

  await setFolderHidden(outer, false);
  data = await snapshot();
  hidden = hiddenFolderIds(data.folders);
  expect(hidden.size).toBe(0);
  expect(data.folders.find((f) => f.id === inner)?.parentId).toBe(outer);
});

test("restoring a folder leaves individually deleted chats deleted", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([CHAT_A, CHAT_B], work);
  await setChatsHidden([CHAT_A], true);

  await setFolderHidden(work, true);
  await setFolderHidden(work, false);

  const data = await snapshot();
  const hidden = hiddenFolderIds(data.folders);
  expect(isChatHidden(data.chats.find((c) => c.uuid === CHAT_A)!, hidden)).toBe(true);
  expect(isChatHidden(data.chats.find((c) => c.uuid === CHAT_B)!, hidden)).toBe(false);
});

test("deleting a chat is undoable and never destroys the record", async () => {
  await setChatsHidden([CHAT_A, CHAT_B], true);
  expect((await snapshot()).chats.filter((c) => c.hidden)).toHaveLength(2);

  await undo();
  const data = await snapshot();
  expect(data.chats).toHaveLength(2);
  expect(data.chats.every((c) => !c.hidden)).toBe(true);
});

test("purging a folder takes its whole subtree, and undo puts all of it back", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  const deep = await createFolder(work, "Deep");
  await moveChats([CHAT_A], deep);
  await createShortcuts([CHAT_B], work);
  await setFolderHidden(work, true);

  await purgeRefs([{ kind: "folder", id: work }]);

  let data = await snapshot();
  expect(data.folders.find((f) => f.id === work)).toBeUndefined();
  expect(data.folders.find((f) => f.id === deep)).toBeUndefined();
  expect(data.shortcuts).toHaveLength(0);
  // The chat record itself is gone — not re-filed under Unfiled, as the old
  // purge did. Only the next sync can bring it back, as a brand-new row.
  expect(data.chats.find((c) => c.uuid === CHAT_A)).toBeUndefined();

  // Deep-first deletion means the inverse list restores parents before children.
  await undo();
  data = await snapshot();
  expect(data.folders.find((f) => f.id === deep)?.parentId).toBe(work);
  expect(data.chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(deep);
  expect(data.shortcuts).toHaveLength(1);
});

test("restoring from deep inside the bin un-hides the folders above it", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  const deep = await createFolder(work, "Deep");
  await moveChats([CHAT_A], deep);
  await setFolderHidden(work, true);

  // Clearing only the chat's own flag would leave it invisible: `work` is still
  // hidden, so `hiddenFolderIds` still covers everything under it.
  await restoreRefs([{ kind: "chat", id: CHAT_A }]);

  const data = await snapshot();
  const hidden = hiddenFolderIds(data.folders);
  expect(hidden.size).toBe(0);
  expect(isChatHidden(data.chats.find((c) => c.uuid === CHAT_A)!, hidden)).toBe(false);
  expect(data.chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(deep);
});

test("the local mark is independent of the server star", async () => {
  await setChatsFlagged([CHAT_A], true);
  const chat = (await snapshot()).chats.find((c) => c.uuid === CHAT_A)!;
  expect(chat.flagged).toBe(true);
  expect(chat.isStarred).toBe(false);

  await undo();
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.flagged).toBe(false);
});

test("a batch of moves undoes as one step", async () => {
  const dest = await createFolder(ROOT_ID, "Dest");
  await moveChats([CHAT_A, CHAT_B], dest);

  await undo();
  const data = await snapshot();
  expect(data.chats.every((c) => c.folderId === UNFILED_ID)).toBe(true);
  // The label is stored as a key + vars, never as rendered text, so the undo
  // history reads correctly even if the user later switches language.
  expect((await historyState()).undoLabel).toEqual({
    key: "opNewFolder",
    vars: { name: "Dest" }
  });
});

test("shortcuts are aliases: the chat keeps its one true location", async () => {
  const refs = await createFolder(ROOT_ID, "Refs");
  await createShortcuts([CHAT_A], refs);

  const data = await snapshot();
  expect(data.chats.find((c) => c.uuid === CHAT_A)?.folderId).toBe(UNFILED_ID);
  expect(data.shortcuts).toHaveLength(1);
  expect(data.shortcuts[0]?.targetUuid).toBe(CHAT_A);

  await deleteShortcuts([data.shortcuts[0]!.id]);
  expect((await snapshot()).shortcuts).toHaveLength(0);
  await undo();
  expect((await snapshot()).shortcuts).toHaveLength(1);
});

test("a duplicate shortcut in the same folder is not created twice", async () => {
  const refs = await createFolder(ROOT_ID, "Refs");
  await createShortcuts([CHAT_A], refs);
  await createShortcuts([CHAT_A], refs);
  expect((await snapshot()).shortcuts).toHaveLength(1);
});

test("a folder cannot be moved inside its own subtree", async () => {
  const outer = await createFolder(ROOT_ID, "Outer");
  const inner = await createFolder(outer, "Inner");
  await expect(moveFolder(outer, inner)).rejects.toThrow(/subfolder/);
  await expect(moveFolder(outer, outer)).rejects.toThrow(/itself/);
});

test("system folders are protected", async () => {
  await expect(renameFolder(UNFILED_ID, "x")).rejects.toThrow();
  await expect(setFolderHidden(ROOT_ID, true)).rejects.toThrow();
  await expect(setFolderHidden(UNFILED_ID, true)).rejects.toThrow();
});

test("sibling folder names are de-duplicated", async () => {
  await createFolder(ROOT_ID, "Work");
  await createFolder(ROOT_ID, "Work");
  const names = (await snapshot()).folders.filter((f) => f.parentId === ROOT_ID).map((f) => f.name);
  expect(names).toContain("Work");
  expect(names).toContain("Work (2)");
});

test("renaming a chat is local and reversible to the remote name", async () => {
  await renameChat(CHAT_A, "My name");
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.displayName).toBe("My name");
  await renameChat(CHAT_A, "");
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.displayName).toBeNull();
  await undo();
  expect((await snapshot()).chats.find((c) => c.uuid === CHAT_A)?.displayName).toBe("My name");
});

test("a url locates the chat's true path and its shortcuts", async () => {
  const work = await createFolder(ROOT_ID, "Work");
  const refs = await createFolder(ROOT_ID, "Refs");
  await moveChats([CHAT_A], work);
  await createShortcuts([CHAT_A], refs);

  const data = await snapshot();
  const hit = locate(`https://claude.ai/chat/${CHAT_A}?foo=1`, data);
  expect(hit?.path.map((f) => f.name)).toEqual(["ChatExplorer", "Work"]);
  expect(hit?.shortcuts).toHaveLength(1);
  expect(hit?.shortcuts[0]?.path.map((f) => f.name)).toEqual(["ChatExplorer", "Refs"]);

  expect(locate("https://claude.ai/chat/does-not-exist", data)).toBeNull();
  expect(folderPath(data.folders, work).map((f) => f.name)).toEqual(["ChatExplorer", "Work"]);
});

test("uuid extraction accepts urls, bare ids and mixed case", () => {
  expect(extractUuid(`https://claude.ai/chat/${CHAT_A}`)).toBe(CHAT_A);
  expect(extractUuid(`  ${CHAT_A.toUpperCase()}  `)).toBe(CHAT_A);
  expect(extractUuid("https://claude.ai/new")).toBeNull();
});
