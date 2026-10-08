import type { MessageKey } from "../ui/i18n";
import { idb, tx } from "./db";
import { commit, type Op, type OpLabel } from "./ops";
import {
  ROOT_ID,
  STACK_MIN_MEMBERS,
  STORE,
  SYSTEM_FOLDER_IDS,
  UNFILED_ID,
  type Chat,
  type Folder,
  type Pos,
  type Shortcut,
  type Stack
} from "./schema";

export interface Snapshot {
  folders: Folder[];
  chats: Chat[];
  shortcuts: Shortcut[];
  stacks: Stack[];
}

/**
 * Picks the singular or plural key for a count-bearing undo label. English needs
 * the distinction; Chinese maps both onto the same wording. The count only ever
 * rides along as a variable, never baked into the stored string.
 */
function countLabel(one: MessageKey, many: MessageKey, n: number): OpLabel {
  return n === 1 ? { key: one } : { key: many, vars: { n } };
}

export async function snapshot(): Promise<Snapshot> {
  return tx([STORE.folders, STORE.chats, STORE.shortcuts, STORE.stacks], "readonly", async (t) => ({
    folders: await idb.getAll<Folder>(t, STORE.folders),
    chats: await idb.getAll<Chat>(t, STORE.chats),
    shortcuts: await idb.getAll<Shortcut>(t, STORE.shortcuts),
    stacks: await idb.getAll<Stack>(t, STORE.stacks)
  }));
}

export function isSystemFolder(id: string): boolean {
  return SYSTEM_FOLDER_IDS.includes(id);
}

/**
 * Ids of folders that are hidden themselves or sit under a hidden ancestor.
 *
 * Hiding a folder deliberately does NOT stamp its descendants, so that
 * restoring it is one flip and items hidden individually beforehand stay
 * hidden afterwards. The cost is that visibility is an ancestor walk, which
 * this resolves once per snapshot.
 */
export function hiddenFolderIds(folders: Folder[]): Set<string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const result = new Set<string>();
  const resolve = (folder: Folder): boolean => {
    if (result.has(folder.id)) return true;
    if (folder.hidden) {
      result.add(folder.id);
      return true;
    }
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    if (parent && resolve(parent)) {
      result.add(folder.id);
      return true;
    }
    return false;
  };
  for (const folder of folders) resolve(folder);
  return result;
}

/** True when the chat is hidden itself or lives under a hidden folder. */
export function isChatHidden(chat: Chat, hiddenFolders: Set<string>): boolean {
  return chat.hidden || hiddenFolders.has(chat.folderId);
}

export function uniqueName(siblings: Folder[], desired: string): string {
  const taken = new Set(siblings.map((f) => f.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export async function createFolder(parentId: string, name = "New folder"): Promise<string> {
  const { folders } = await snapshot();
  const folder: Folder = {
    id: crypto.randomUUID(),
    parentId,
    name: uniqueName(
      folders.filter((f) => f.parentId === parentId),
      name.trim() || "New folder"
    ),
    createdAt: Date.now(),
    hidden: false,
    pos: null
  };
  await commit({ key: "opNewFolder", vars: { name: folder.name } }, [{ t: "folder.put", folder }]);
  return folder.id;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  if (isSystemFolder(id)) throw new Error("This folder cannot be renamed.");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name cannot be empty.");
  const { folders } = await snapshot();
  const folder = folders.find((f) => f.id === id);
  if (!folder || folder.name === trimmed) return;
  await commit({ key: "opRenameTo", vars: { name: trimmed } }, [
    { t: "folder.put", folder: { ...folder, name: trimmed } }
  ]);
}

function isDescendant(folders: Folder[], candidate: string, ancestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let node = byId.get(candidate);
  while (node?.parentId) {
    if (node.parentId === ancestor) return true;
    node = byId.get(node.parentId);
  }
  return false;
}

export async function moveFolder(id: string, parentId: string): Promise<void> {
  if (isSystemFolder(id)) throw new Error("This folder cannot be moved.");
  if (id === parentId) throw new Error("A folder cannot contain itself.");
  const { folders } = await snapshot();
  const folder = folders.find((f) => f.id === id);
  if (!folder || folder.parentId === parentId) return;
  if (isDescendant(folders, parentId, id)) {
    throw new Error("A folder cannot be moved into one of its own subfolders.");
  }
  await commit({ key: "opMoveFolder", vars: { name: folder.name } }, [
    { t: "folder.put", folder: { ...folder, parentId } }
  ]);
}

/**
 * Delete semantics for a folder: hide it, subtree and all. Nothing is destroyed
 * and nothing is re-filed, so restoring is a single flip.
 */
export async function setFolderHidden(id: string, hidden: boolean): Promise<void> {
  if (isSystemFolder(id)) throw new Error("This folder cannot be deleted.");
  const { folders } = await snapshot();
  const folder = folders.find((f) => f.id === id);
  if (!folder || folder.hidden === hidden) return;
  await commit(
    { key: hidden ? "opDeleteFolder" : "opRestoreFolder", vars: { name: folder.name } },
    [{ t: "folder.put", folder: { ...folder, hidden } }]
  );
}

/** Ids of `id` and every folder beneath it. */
function subtreeIds(folders: Folder[], id: string): string[] {
  const children = new Map<string, Folder[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f);
    else children.set(f.parentId, [f]);
  }
  const out: string[] = [];
  const walk = (current: string) => {
    out.push(current);
    for (const child of children.get(current) ?? []) walk(child.id);
  };
  walk(id);
  return out;
}

/**
 * Permanent deletion, cascading.
 *
 * 〔修订 2026-09-19 第三批〕The old `purgeFolder` deliberately spared the
 * contents — subfolders rose to the parent, chats fell back to Unfiled. The
 * user reported that as a bug (「彻底删除某个文件夹并不会连带删除文件夹下的所有
 * 文件夹和文件」) and they are right: in a file manager, emptying the bin
 * destroys what is in the bin. So a folder now takes its whole subtree with it.
 *
 * Two consequences worth stating plainly:
 *
 *  - **Chats are dropped as records, not as conversations.** claude.ai is
 *    read-only for us, so the conversation survives there; the next full sync
 *    sees a uuid it has no row for and re-adds it as a new, unfiled chat. The
 *    confirmation dialog says so, because a "permanent" delete that quietly
 *    comes back would be the worse surprise.
 *  - **It is still undoable.** Every op has an inverse, so Ctrl+Z restores the
 *    whole subtree. "Permanent" here means "not in the bin any more", the same
 *    thing it means in Explorer.
 *
 * Deep folders are deleted before shallow ones so that the inverse list — which
 * `commit` replays in reverse — puts parents back before their children.
 */
export async function purgeRefs(refs: ItemRef[]): Promise<void> {
  if (refs.length === 0) return;
  const { folders, chats, shortcuts, stacks } = await snapshot();

  const doomedFolders = new Set<string>();
  for (const ref of refs) {
    if (ref.kind !== "folder" || isSystemFolder(ref.id)) continue;
    for (const id of subtreeIds(folders, ref.id)) {
      if (!isSystemFolder(id)) doomedFolders.add(id);
    }
  }

  const doomedChats = new Set(refs.filter((r) => r.kind === "chat").map((r) => r.id));
  for (const chat of chats) {
    if (doomedFolders.has(chat.folderId)) doomedChats.add(chat.uuid);
  }

  // A shortcut whose folder or whose target is going away would be a dangling
  // alias, which the list layer already has to skip — so it goes too.
  const doomedShortcuts = new Set(refs.filter((r) => r.kind === "shortcut").map((r) => r.id));
  for (const sc of shortcuts) {
    if (doomedFolders.has(sc.folderId) || doomedChats.has(sc.targetUuid)) doomedShortcuts.add(sc.id);
  }

  // The one place stacks have to be swept up. Everywhere else a stale member id
  // simply fails to resolve at read time, but a stack whose *folder* is gone can
  // never be reached again to be dissolved by hand, so it would linger forever.
  const doomedStacks = stacks.filter((s) => doomedFolders.has(s.folderId));

  const depth = new Map(folders.map((f) => [f.id, folderPath(folders, f.id).length]));
  const folderOrder = [...doomedFolders].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));

  const ops: Op[] = [];
  for (const stack of doomedStacks) ops.push({ t: "stack.del", id: stack.id });
  for (const id of doomedShortcuts) ops.push({ t: "shortcut.del", id });
  for (const uuid of doomedChats) ops.push({ t: "chat.del", uuid });
  for (const id of folderOrder) ops.push({ t: "folder.del", id });
  if (ops.length === 0) return;

  const onlyFolder =
    refs.length === 1 && refs[0]?.kind === "folder"
      ? folders.find((f) => f.id === refs[0]?.id)
      : undefined;
  await commit(
    onlyFolder
      ? { key: "opPurgeFolder", vars: { name: onlyFolder.name } }
      : countLabel("opPurge", "opPurgeMany", refs.length),
    ops
  );
}

/**
 * Undelete, ancestors included.
 *
 * Restoring used to be one flip of one flag, which was right while the bin was
 * a flat list. Now that a deleted folder can be opened and rummaged through, a
 * chat restored from three levels down would clear its own flag and stay
 * invisible, because the folders above it are still hidden. So a restore walks
 * up and un-hides whatever is in the way — the item genuinely comes back to
 * where it was, which is the only outcome the word promises.
 */
export async function restoreRefs(refs: ItemRef[]): Promise<void> {
  if (refs.length === 0) return;
  const { folders, chats, shortcuts } = await snapshot();
  const byId = new Map(folders.map((f) => [f.id, f]));

  const unhide = new Set<string>();
  const addAncestors = (folderId: string | null | undefined) => {
    let node = folderId ? byId.get(folderId) : undefined;
    while (node) {
      if (node.hidden) unhide.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  };

  const chatUuids: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "folder") {
      const folder = byId.get(ref.id);
      if (!folder) continue;
      unhide.add(ref.id);
      addAncestors(folder.parentId);
    } else if (ref.kind === "chat") {
      chatUuids.push(ref.id);
      addAncestors(chats.find((c) => c.uuid === ref.id)?.folderId);
    } else {
      // A shortcut has no hidden flag of its own; it reappears as soon as its
      // folder and its target do.
      const sc = shortcuts.find((s) => s.id === ref.id);
      addAncestors(sc?.folderId);
      const target = sc ? chats.find((c) => c.uuid === sc.targetUuid) : undefined;
      if (target?.hidden) chatUuids.push(target.uuid);
    }
  }

  const ops: Op[] = [];
  for (const id of unhide) {
    const folder = byId.get(id);
    if (folder) ops.push({ t: "folder.put", folder: { ...folder, hidden: false } });
  }
  for (const uuid of chatUuids) ops.push({ t: "chat.patch", uuid, patch: { hidden: false } });
  if (ops.length === 0) return;

  const onlyFolder =
    refs.length === 1 && refs[0]?.kind === "folder" ? byId.get(refs[0].id) : undefined;
  await commit(
    onlyFolder
      ? { key: "opRestoreFolder", vars: { name: onlyFolder.name } }
      : countLabel("opRestoreItem", "opRestoreItems", refs.length),
    ops
  );
}

/**
 * Delete semantics for a chat. A real delete is impossible — the conversation
 * lives on claude.ai and the next full sync would bring it straight back — so
 * hiding is the terminal local state.
 */
export async function setChatsHidden(uuids: string[], hidden: boolean): Promise<void> {
  const ops: Op[] = uuids.map((uuid) => ({ t: "chat.patch", uuid, patch: { hidden } }));
  const label = hidden
    ? countLabel("opDeleteChat", "opDeleteChats", uuids.length)
    : countLabel("opRestoreChat", "opRestoreChats", uuids.length);
  await commit(label, ops);
}

/** The writable local mark, as opposed to the read-only server star. */
export async function setChatsFlagged(uuids: string[], flagged: boolean): Promise<void> {
  const ops: Op[] = uuids.map((uuid) => ({ t: "chat.patch", uuid, patch: { flagged } }));
  const label = flagged
    ? countLabel("opMarkChat", "opMarkChats", uuids.length)
    : countLabel("opUnmarkChat", "opUnmarkChats", uuids.length);
  await commit(label, ops);
}

/** Ctrl+X semantics: relocate the chat itself. */
export async function moveChats(uuids: string[], folderId: string): Promise<void> {
  const ops: Op[] = uuids.map((uuid) => ({ t: "chat.patch", uuid, patch: { folderId } }));
  await commit(countLabel("opMoveChat", "opMoveChats", uuids.length), ops);
}

/** Ctrl+C semantics: leave the chat where it is and drop an alias here. */
export async function createShortcuts(uuids: string[], folderId: string): Promise<string[]> {
  const { shortcuts } = await snapshot();
  const existing = new Set(
    shortcuts.filter((s) => s.folderId === folderId).map((s) => s.targetUuid)
  );
  const fresh = uuids.filter((u) => !existing.has(u));
  if (fresh.length === 0) return [];
  const created = fresh.map<Shortcut>((targetUuid) => ({
    id: crypto.randomUUID(),
    targetUuid,
    folderId,
    createdAt: Date.now(),
    pos: null
  }));
  await commit(
    countLabel("opPasteShortcut", "opPasteShortcuts", created.length),
    created.map((shortcut) => ({ t: "shortcut.put", shortcut }))
  );
  return created.map((s) => s.id);
}

export async function moveShortcuts(ids: string[], folderId: string): Promise<void> {
  const { shortcuts } = await snapshot();
  const ops: Op[] = [];
  for (const id of ids) {
    const sc = shortcuts.find((s) => s.id === id);
    if (sc && sc.folderId !== folderId) ops.push({ t: "shortcut.put", shortcut: { ...sc, folderId } });
  }
  await commit(countLabel("opMoveShortcut", "opMoveShortcuts", ops.length), ops);
}

export async function deleteShortcuts(ids: string[]): Promise<void> {
  const ops: Op[] = ids.map((id) => ({ t: "shortcut.del", id }));
  await commit(countLabel("opDeleteShortcut", "opDeleteShortcuts", ids.length), ops);
}

// --- stacks ----------------------------------------------------------------
//
// Every function here writes exactly one Stack record, or drops it. Nothing
// touches a Chat, a Shortcut or a Folder, which is the whole point: a stack is
// a fold drawn over items that never move. See the `Stack` doc comment.

/**
 * Folds a selection into a pile. Returns the new stack's id, or `null` when
 * there was nothing worth folding.
 *
 * Members that already belong to another stack in this folder are pulled out of
 * it first — an item can only be in one pile, the same way it can only be in one
 * folder, and silently leaving it in two would make the two piles disagree about
 * how many items the folder has. A stack left below the minimum by that theft
 * dissolves in the same undo step.
 */
export async function createStack(
  folderId: string,
  members: string[],
  pos: Pos | null = null
): Promise<string | null> {
  const unique = [...new Set(members)];
  if (unique.length < STACK_MIN_MEMBERS) return null;
  const { stacks } = await snapshot();

  const taken = new Set(unique);
  const ops: Op[] = [];
  for (const stack of stacks) {
    if (stack.folderId !== folderId) continue;
    const kept = stack.members.filter((key) => !taken.has(key));
    if (kept.length === stack.members.length) continue;
    ops.push(
      kept.length < STACK_MIN_MEMBERS
        ? { t: "stack.del", id: stack.id }
        : { t: "stack.put", stack: { ...stack, members: kept } }
    );
  }

  const stack: Stack = {
    id: crypto.randomUUID(),
    folderId,
    name: null,
    members: unique,
    createdAt: Date.now(),
    pos
  };
  ops.push({ t: "stack.put", stack });
  await commit({ key: "opStack", vars: { n: unique.length } }, ops);
  return stack.id;
}

/** Unfolds the pile for good. The items were never anywhere else, so that is all. */
export async function dissolveStack(id: string): Promise<void> {
  const { stacks } = await snapshot();
  if (!stacks.some((s) => s.id === id)) return;
  await commit({ key: "opUnstack" }, [{ t: "stack.del", id }]);
}

/** `null` hands the name back to the derived date range. */
export async function renameStack(id: string, name: string | null): Promise<void> {
  const { stacks } = await snapshot();
  const stack = stacks.find((s) => s.id === id);
  if (!stack) return;
  const trimmed = name?.trim() ?? "";
  const next = trimmed === "" ? null : trimmed;
  if (next === stack.name) return;
  await commit(next ? { key: "opRenameTo", vars: { name: next } } : { key: "opRestoreName" }, [
    { t: "stack.put", stack: { ...stack, name: next } }
  ]);
}

/** Drop-onto-the-pile. Keys already in it are ignored rather than duplicated. */
export async function addToStack(id: string, members: string[]): Promise<void> {
  const { stacks } = await snapshot();
  const stack = stacks.find((s) => s.id === id);
  if (!stack) return;
  const present = new Set(stack.members);
  const fresh = [...new Set(members)].filter((key) => !present.has(key));
  if (fresh.length === 0) return;

  const taken = new Set(fresh);
  const ops: Op[] = [];
  for (const other of stacks) {
    if (other.id === id || other.folderId !== stack.folderId) continue;
    const kept = other.members.filter((key) => !taken.has(key));
    if (kept.length === other.members.length) continue;
    ops.push(
      kept.length < STACK_MIN_MEMBERS
        ? { t: "stack.del", id: other.id }
        : { t: "stack.put", stack: { ...other, members: kept } }
    );
  }
  ops.push({ t: "stack.put", stack: { ...stack, members: [...stack.members, ...fresh] } });
  await commit(countLabel("opAddToStack", "opAddToStackMany", fresh.length), ops);
}

/**
 * Takes items back out and lays them loose in the folder again. A pile that
 * falls below the minimum is not left as a pile of one — it dissolves, which is
 * also what macOS does when a stack empties out.
 */
export async function removeFromStack(id: string, members: string[]): Promise<void> {
  const { stacks } = await snapshot();
  const stack = stacks.find((s) => s.id === id);
  if (!stack) return;
  const dropped = new Set(members);
  const kept = stack.members.filter((key) => !dropped.has(key));
  if (kept.length === stack.members.length) return;
  const n = stack.members.length - kept.length;
  await commit(
    countLabel("opRemoveFromStack", "opRemoveFromStackMany", n),
    kept.length < STACK_MIN_MEMBERS
      ? [{ t: "stack.del", id }]
      : [{ t: "stack.put", stack: { ...stack, members: kept } }]
  );
}

export async function renameChat(uuid: string, name: string | null): Promise<void> {
  const trimmed = name?.trim() ?? "";
  const displayName = trimmed === "" ? null : trimmed;
  await commit(displayName ? { key: "opRenameTo", vars: { name: displayName } } : { key: "opRestoreName" }, [
    { t: "chat.patch", uuid, patch: { displayName } }
  ]);
}

export async function setNotes(uuid: string, notes: string): Promise<void> {
  await commit({ key: "opEditNote" }, [{ t: "chat.patch", uuid, patch: { notes } }]);
}

/**
 * An addressable thing in a folder. Free layout and selection both need this.
 *
 * `stack` is the odd one out: it addresses a *fold*, not a filed object, and
 * for a derived auto-stack there is no record behind the id at all. Anything
 * that means "the chats under this" has to go through `refsToChatUuids`, which
 * expands a stack into its members; nothing may look a stack id up in a store
 * and assume it is there.
 */
export type ItemRef =
  | { kind: "chat"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "shortcut"; id: string }
  | { kind: "stack"; id: string };

/**
 * Free-layout drag. Batched into one undo step so dragging a multi-selection
 * back is a single Ctrl+Z.
 */
export async function setPositions(moves: { ref: ItemRef; pos: Pos | null }[]): Promise<void> {
  if (moves.length === 0) return;
  const { folders, shortcuts } = await snapshot();
  const ops: Op[] = [];
  for (const { ref, pos } of moves) {
    if (ref.kind === "chat") {
      ops.push({ t: "chat.patch", uuid: ref.id, patch: { pos } });
    } else if (ref.kind === "folder") {
      const folder = folders.find((f) => f.id === ref.id);
      if (folder) ops.push({ t: "folder.put", folder: { ...folder, pos } });
    } else {
      const sc = shortcuts.find((s) => s.id === ref.id);
      if (sc) ops.push({ t: "shortcut.put", shortcut: { ...sc, pos } });
    }
  }
  await commit(countLabel("opMoveIcon", "opMoveIcons", moves.length), ops);
}

/** Resolves the chain of folder names from root down to `folderId`, inclusive. */
/**
 * One batch from the AI organizer, as one undo step. The ops were planned and
 * scope-checked by `agent/tools.ts` against a snapshot taken just before this
 * call; the label carries the model's own one-line description of the batch
 * so the history panel can name it. Returns the step's seq — the anchor the
 * conversation keeps so the user can rewind to just before this batch.
 */
export async function applyAgentOps(summary: string, ops: Op[]): Promise<number> {
  return commit({ key: "opAgent", vars: { summary } }, ops);
}

export function folderPath(folders: Folder[], folderId: string): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  let node = byId.get(folderId);
  while (node) {
    path.unshift(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return path;
}

export { ROOT_ID, UNFILED_ID };
