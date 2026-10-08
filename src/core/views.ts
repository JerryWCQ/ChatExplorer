import { idb, tx } from "./db";
import {
  defaultView,
  ROOT_ID,
  STORE,
  UNFILED_ID,
  unfiledView,
  type Folder,
  type FolderView
} from "./schema";

/**
 * Per-folder view state: sort, grouping, view mode, icon size.
 *
 * Kept out of both the folder record and the undo log on purpose. Changing a
 * sort order should not consume an undo step, and undoing an unrelated rename
 * should not drag the sort order back with it.
 *
 * A folder with no row of its own inherits from its nearest ancestor that has
 * one. That satisfies "a new folder inherits its parent's settings" without a
 * write, and keeps the child tracking the parent until it is explicitly changed.
 */
export async function loadViews(): Promise<Map<string, FolderView>> {
  const rows = await tx([STORE.views], "readonly", (t) => idb.getAll<FolderView>(t, STORE.views));
  return new Map(rows.map((v) => [v.folderId, v]));
}

export function resolveView(
  views: Map<string, FolderView>,
  folders: Folder[],
  folderId: string
): FolderView {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let id: string | null | undefined = folderId;
  while (id) {
    const own = views.get(id);
    if (own) return { ...own, folderId };
    id = byId.get(id)?.parentId;
  }
  const base = folderId === UNFILED_ID ? unfiledView() : defaultView(folderId);
  return base;
}

export async function saveView(view: FolderView): Promise<void> {
  await tx([STORE.views], "readwrite", (t) => idb.put(t, STORE.views, view));
}

/** Drops the folder's own row so it inherits from its parent again. */
export async function resetView(folderId: string): Promise<void> {
  if (folderId === ROOT_ID) return;
  await tx([STORE.views], "readwrite", (t) => idb.del(t, STORE.views, folderId));
}
