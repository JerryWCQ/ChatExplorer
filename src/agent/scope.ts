/**
 * What the agent may read and write, derived from what the user right-clicked.
 *
 * This is the permission boundary, so it is enforced here, in code, against
 * every id the model sends back — never by asking the model to stay inside.
 * The model is untrusted input: it hallucinates ids, it misreads handles, and
 * a prompt is not a fence.
 *
 * The three shapes (user decisions 2026-09-24):
 *
 *  - **Blank space → everything.** Read and write the whole visible library.
 *  - **Folders selected → those subtrees.** Read and write only inside them:
 *    chats in them, folders under them, new folders only beneath them, and
 *    every move lands inside them. Loose chats selected alongside join in and
 *    may be moved into the subtrees.
 *  - **Only chats selected → only those chats.** The agent may read the whole
 *    library (it needs to see where things could go) and move the selected
 *    chats into any folder, creating new ones if needed; it may not touch any
 *    other chat or any existing folder.
 *
 * Soft-deleted items (hidden, or under a hidden folder) are outside every
 * scope: the bin is not something to organize.
 */

import { ROOT_ID, SYSTEM_FOLDER_IDS, type Chat, type Folder } from "../core/schema";
import { hiddenFolderIds, type Snapshot } from "../core/store";
import type { AgentScope } from "./types";

export type AccessMode = "all" | "folders" | "chats";

export interface Access {
  mode: AccessMode;
  /** Folders the user selected (mode "folders") — the tops of the subtrees. */
  roots: string[];
  canReadChat(chat: Chat): boolean;
  canWriteChat(chat: Chat): boolean;
  /** Shown in the folder tree and listable. */
  canReadFolder(id: string): boolean;
  /** May receive chats or folders. */
  canMoveInto(id: string): boolean;
  /** May have subfolders created under it. */
  canCreateIn(id: string): boolean;
  /** May be renamed, moved or deleted itself. */
  canEditFolder(id: string): boolean;
}

function subtree(folders: Folder[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f.id);
    else children.set(f.parentId, [f.id]);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export function resolveAccess(scope: AgentScope, snap: Snapshot): Access {
  const hidden = hiddenFolderIds(snap.folders);
  const exists = new Set(snap.folders.map((f) => f.id));
  const visibleFolder = (id: string) => exists.has(id) && !hidden.has(id);
  const visibleChat = (c: Chat) => !c.hidden && !hidden.has(c.folderId);
  const isSystem = (id: string) => SYSTEM_FOLDER_IDS.includes(id);

  if (scope.kind === "all") {
    return {
      mode: "all",
      roots: [],
      canReadChat: visibleChat,
      canWriteChat: visibleChat,
      canReadFolder: visibleFolder,
      canMoveInto: visibleFolder,
      canCreateIn: visibleFolder,
      canEditFolder: (id) => visibleFolder(id) && !isSystem(id)
    };
  }

  const roots = scope.folderIds.filter(visibleFolder);
  const picked = new Set(scope.chatUuids);

  if (roots.length === 0) {
    // Only chats: read everything, write only these, file them anywhere.
    return {
      mode: "chats",
      roots: [],
      canReadChat: visibleChat,
      canWriteChat: (c) => picked.has(c.uuid) && visibleChat(c),
      canReadFolder: visibleFolder,
      canMoveInto: visibleFolder,
      canCreateIn: visibleFolder,
      canEditFolder: () => false
    };
  }

  const inside = new Set<string>();
  for (const root of roots) for (const id of subtree(snap.folders, root)) inside.add(id);
  const inScope = (id: string) => inside.has(id) && visibleFolder(id);
  const chatInScope = (c: Chat) => visibleChat(c) && (inside.has(c.folderId) || picked.has(c.uuid));

  return {
    mode: "folders",
    roots,
    canReadChat: chatInScope,
    canWriteChat: chatInScope,
    canReadFolder: inScope,
    canMoveInto: inScope,
    canCreateIn: inScope,
    // A selected root may be renamed or deleted, but not moved: every
    // destination is inside the scope, and a folder cannot move into itself.
    canEditFolder: (id) => inScope(id) && !isSystem(id)
  };
}

/** Chats the scope is *about* — what "N 个对话" in the panel header counts. */
export function scopeChats(access: Access, snap: Snapshot): Chat[] {
  return snap.chats.filter((c) => access.canWriteChat(c));
}

/** The folders a tree view should start from: the roots, or the library root. */
export function treeRoots(access: Access): string[] {
  return access.mode === "folders" ? access.roots : [ROOT_ID];
}
