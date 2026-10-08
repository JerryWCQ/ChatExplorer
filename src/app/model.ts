/**
 * Pure view-model layer: turns a Snapshot plus a Location into the sorted,
 * grouped list of items a view renders. No IndexedDB, no React — everything
 * here is unit-testable with plain objects.
 */

import { compareModel, modelInfo } from "../core/model";
import {
  ROOT_ID,
  STACK_MIN_MEMBERS,
  UNFILED_ID,
  type Chat,
  type Folder,
  type FolderView,
  type GroupKey,
  type Pos,
  type Shortcut,
  type SortKey,
  type Stack
} from "../core/schema";
import { folderPath, hiddenFolderIds, isChatHidden, type ItemRef } from "../core/store";
import type { Snapshot } from "../core/store";
import { dayKey, displayName, rangeLabel } from "../ui/format";
import { monthLabel } from "../ui/format";
import type { Lang, T } from "../ui/i18n";

// --- locations ---------------------------------------------------------------

export type VirtualId = "recent" | "flagged" | "starred" | "missing" | "hidden";
export const VIRTUAL_IDS: readonly VirtualId[] = [
  "recent",
  "flagged",
  "starred",
  "missing",
  "hidden"
];

export type Location =
  | { kind: "folder"; folderId: string }
  | { kind: "virtual"; id: VirtualId }
  | { kind: "search"; query: string; scopeFolderId: string };

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId;
  if (a.kind === "virtual" && b.kind === "virtual") return a.id === b.id;
  if (a.kind === "search" && b.kind === "search")
    return a.query === b.query && a.scopeFolderId === b.scopeFolderId;
  return false;
}

export function locationKey(loc: Location): string {
  if (loc.kind === "folder") return `folder:${loc.folderId}`;
  if (loc.kind === "virtual") return `virtual:${loc.id}`;
  return `search:${loc.scopeFolderId}:${loc.query}`;
}

// --- items --------------------------------------------------------------------

export interface Item {
  ref: ItemRef;
  /** `${kind}:${id}` — stable identity for selection sets and React keys. */
  key: string;
  /** Resolved display name (folder name, or chat name via the fallback chain). */
  name: string;
  folder?: Folder;
  /**
   * Present for kind "chat", for kind "shortcut" (the resolved target), and for
   * kind "stack" (the pile's *representative*, see `StackInfo`).
   */
  chat?: Chat;
  shortcut?: Shortcut;
  stack?: StackInfo;
  /**
   * Set on the members of an *expanded* pile, and only there. The view uses it
   * to tint the run so it reads as one group, and to stagger the fan-out; the
   * context menu uses it to offer 「移出叠放」 on an item that is in one.
   */
  inStack?: string;
  /** Ordinal within that pile — the animation's stagger index. */
  stackIndex?: number;
}

/**
 * A resolved pile, ready to draw. Built fresh on every list rebuild — never
 * stored, never cached — so a stale member id costs nothing.
 *
 * **The representative.** A stack item carries `chat` = its newest member's
 * chat, exactly as macOS draws the most recent file on top of the pile. That is
 * not decoration: it is what lets `compareBy`, `groupItems` and the preview
 * pane treat a stack as "a thing with a date and a model" without a single
 * special case. Code that needs the pile rather than its top card branches on
 * `ref.kind === "stack"` and reads `item.stack`.
 */
export interface StackInfo {
  id: string;
  folderId: string;
  /**
   * The persisted record, or `null` for an auto-stack, which exists only for as
   * long as this list does. A null record is also the "you cannot rename or
   * dissolve this" signal — auto-stacks are a property of the view, and the way
   * to get rid of one is to turn the view option off.
   */
  record: Stack | null;
  /** Members in the folder's current sort order; always ≥ STACK_MIN_MEMBERS. */
  members: Item[];
  /** ISO bounds of the members' updatedAt — the source of the 时间段 name. */
  updatedFrom: string;
  updatedTo: string;
  pos: Pos | null;
}

/** True when this pile is derived from the view option rather than stored. */
export function isAutoStack(info: StackInfo): boolean {
  return info.record === null;
}

export function itemKey(ref: ItemRef): string {
  return `${ref.kind}:${ref.id}`;
}

function chatItem(chat: Chat, lang: Lang, t: T): Item {
  return {
    ref: { kind: "chat", id: chat.uuid },
    key: `chat:${chat.uuid}`,
    name: displayName(chat, lang, t),
    chat
  };
}

/**
 * System folders (root, unfiled) are stored with fixed English names because the
 * index must not depend on the UI language. Every place that shows a folder name
 * resolves it through here so the list, the tree, the breadcrumb and the
 * preview pane all agree.
 */
export function folderDisplayName(folder: Folder, t: T): string {
  // `navRoot`, not `navFolders`: the root is a destination you stand in, and
  // calling it "Folders" made the breadcrumb read like a category heading
  // instead of a path. `navFolders` still labels the folder block in a list.
  if (folder.id === ROOT_ID) return t("navRoot");
  if (folder.id === UNFILED_ID) return t("navUnfiled");
  return folder.name;
}

/** "A / B / C" with system folders localised. */
export function folderPathLabel(folders: Folder[], folderId: string, t: T): string {
  return folderPath(folders, folderId)
    .map((f) => folderDisplayName(f, t))
    .join(" / ");
}

function folderItem(folder: Folder, t: T): Item {
  return {
    ref: { kind: "folder", id: folder.id },
    key: `folder:${folder.id}`,
    name: folderDisplayName(folder, t),
    folder
  };
}

/** All descendants of `folderId`, inclusive. */
export function subtreeIds(folders: Folder[], folderId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f.id);
    else children.set(f.parentId, [f.id]);
  }
  const result = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const child of children.get(id) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * Search normalisation (approved deviation to DESIGN 7): lowercase plus
 * fullwidth→halfwidth folding, so "ＡＢＣ" matches "abc" and "１２３" matches
 * "123". Applied to both query and haystack; plain substring match after that.
 */
export function normalizeForSearch(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out.toLowerCase();
}

export interface ListContext {
  data: Snapshot;
  lang: Lang;
  t: T;
  /** Folders hidden directly or via a hidden ancestor, resolved once. */
  hiddenFolders: Set<string>;
  recentCount: number;
}

export function makeListContext(
  data: Snapshot,
  lang: Lang,
  t: T,
  recentCount: number
): ListContext {
  return { data, lang, t, hiddenFolders: hiddenFolderIds(data.folders), recentCount };
}

/** The raw, unsorted item list for a location. */
export function listItems(ctx: ListContext, loc: Location): Item[] {
  const { data, lang, t, hiddenFolders } = ctx;
  const chatByUuid = new Map(data.chats.map((c) => [c.uuid, c]));

  if (loc.kind === "folder") {
    // Opening a deleted folder from the bin inverts the visibility rule: inside
    // the bin, hidden IS the content. Without this the folder opened empty, and
    // the breadcrumb claimed it was a normal folder under the root — the two
    // halves of the user's 「"已删除"下的文件夹点开后…」 report.
    const trashed = hiddenFolders.has(loc.folderId);
    const items: Item[] = [];
    for (const f of data.folders) {
      if (f.parentId !== loc.folderId) continue;
      if (trashed || (!f.hidden && !hiddenFolders.has(f.id))) items.push(folderItem(f, t));
    }
    for (const c of data.chats) {
      if (c.folderId === loc.folderId && (trashed || !c.hidden)) items.push(chatItem(c, lang, t));
    }
    for (const s of data.shortcuts) {
      if (s.folderId !== loc.folderId) continue;
      const target = chatByUuid.get(s.targetUuid);
      // A shortcut to a hidden or vanished chat is noise; skip it.
      if (!target || (!trashed && isChatHidden(target, hiddenFolders))) continue;
      items.push({
        ref: { kind: "shortcut", id: s.id },
        key: `shortcut:${s.id}`,
        name: displayName(target, lang, t),
        chat: target,
        shortcut: s
      });
    }
    return items;
  }

  if (loc.kind === "virtual") {
    const visible = data.chats.filter((c) => !isChatHidden(c, hiddenFolders));
    switch (loc.id) {
      case "recent":
        return visible
          .sort((a, b) => compareIso(b.updatedAt, a.updatedAt))
          .slice(0, ctx.recentCount)
          .map((c) => chatItem(c, lang, t));
      case "flagged":
        return visible.filter((c) => c.flagged).map((c) => chatItem(c, lang, t));
      case "starred":
        return visible.filter((c) => c.isStarred).map((c) => chatItem(c, lang, t));
      case "missing":
        return visible.filter((c) => c.status === "missing").map((c) => chatItem(c, lang, t));
      case "hidden": {
        // Top-level hidden things only: a folder hidden by an ancestor is
        // restored by restoring that ancestor, so listing it separately would
        // just invite a confusing partial restore.
        const items: Item[] = data.folders
          .filter((f) => f.hidden)
          .map((f) => folderItem(f, t));
        for (const c of data.chats) {
          if (c.hidden) items.push(chatItem(c, lang, t));
        }
        return items;
      }
    }
  }

  // search: normalized full scan over name/summary/notes within the scope subtree
  const scope =
    loc.scopeFolderId === ROOT_ID ? null : subtreeIds(data.folders, loc.scopeFolderId);
  const needle = normalizeForSearch(loc.query.trim());
  if (!needle) return [];
  const items: Item[] = [];
  for (const c of data.chats) {
    if (isChatHidden(c, hiddenFolders)) continue;
    if (scope && !scope.has(c.folderId)) continue;
    const hay = normalizeForSearch(
      `${c.displayName ?? ""}\n${c.remoteName}\n${c.summary}\n${c.notes}`
    );
    if (hay.includes(needle)) items.push(chatItem(c, lang, t));
  }
  for (const f of data.folders) {
    if (f.hidden || ctx.hiddenFolders.has(f.id)) continue;
    if (scope && !(scope.has(f.parentId ?? "") || scope.has(f.id))) continue;
    if (f.id === ROOT_ID || f.id === UNFILED_ID) continue;
    if (normalizeForSearch(f.name).includes(needle)) items.push(folderItem(f, t));
  }
  return items;
}

// --- stacks --------------------------------------------------------------------

/** Auto-stack ids are namespaced so they can never collide with a real uuid. */
export function autoStackId(day: string): string {
  return `auto:day:${day}`;
}

function stackItem(
  info: StackInfo,
  lang: Lang,
  t: T
): Item {
  // The representative is the newest member, which is the card macOS draws on
  // top of the pile. Members are already in the view's sort order, but that
  // order may be anything, so "newest" is computed rather than assumed.
  let top: Item | undefined;
  for (const m of info.members) {
    if (!m.chat) continue;
    if (!top?.chat || compareIso(m.chat.updatedAt, top.chat.updatedAt) > 0) top = m;
  }
  return {
    ref: { kind: "stack", id: info.id },
    key: `stack:${info.id}`,
    name: info.record?.name ?? rangeLabel(info.updatedFrom, info.updatedTo, lang, t),
    chat: top?.chat,
    stack: info
  };
}

/**
 * Folds a folder's already-sorted item list into piles.
 *
 * **Runs after sorting, not before.** A pile then simply takes the slot of its
 * first member, which is both the cheapest thing to implement and the only
 * thing that makes an expanded stack readable: expanding has to put the
 * members *right where the pile was*, and no sort key could be trusted to keep
 * them together. It also means `sortItems` and `compareBy` know nothing about
 * stacks at all.
 *
 * Three rules decide what folds:
 *  - **Folders never fold.** A folder is a real container; burying it in a
 *    visual one would make the two impossible to tell apart.
 *  - **`autoStack === "day"` supersedes hand-made stacks** while it is on, the
 *    way macOS greys out manual arrangement under Use Stacks. The stored piles
 *    are untouched and return the moment it goes off.
 *  - **A pile needs `STACK_MIN_MEMBERS` present right now.** A stored stack
 *    whose members have mostly moved away renders as loose items instead, and
 *    nothing is written to fix it — a read must never mutate.
 *
 * An expanded pile emits the stack item *followed by* its members: the item is
 * what the view draws as the collapse button sitting in the pile's old slot
 * (「原位置用一个按钮替代」).
 */
export function foldStacks(
  items: Item[],
  ctx: ListContext,
  loc: Location,
  view: FolderView,
  expanded?: ReadonlySet<string>
): Item[] {
  // Cross-folder views (recent, flagged, search…) have no folder whose fold
  // this would be, and the details view is a flat table by definition.
  if (loc.kind !== "folder" || view.mode === "details") return items;

  const auto = view.autoStack === "day";
  const order: string[] = [];
  const buckets = new Map<string, { record: Stack | null; members: Item[] }>();
  const bucketOf = new Map<string, string>();

  // A folder is a real container and never folds; an item with no resolved chat
  // has no date, so it could not be placed in a range-named pile anyway. Both
  // the bucketing pass and the emit pass ask this, or a folder listed in a
  // stored stack's `members` would vanish into the pile.
  const foldable = (item: Item) => item.ref.kind !== "folder" && !!item.chat;

  if (auto) {
    for (const item of items) {
      if (!foldable(item)) continue;
      bucketOf.set(item.key, autoStackId(dayKey(item.chat!.updatedAt)));
    }
  } else {
    for (const stack of ctx.data.stacks) {
      if (stack.folderId !== loc.folderId) continue;
      for (const key of stack.members) {
        // First stack wins. Two piles claiming the same item is a state the
        // writers prevent, but a read must still be total.
        if (!bucketOf.has(key)) bucketOf.set(key, stack.id);
      }
    }
  }
  const records = new Map(ctx.data.stacks.map((s) => [s.id, s]));

  for (const item of items) {
    const id = foldable(item) ? bucketOf.get(item.key) : undefined;
    if (id === undefined) continue;
    const hit = buckets.get(id);
    if (hit) hit.members.push(item);
    else {
      buckets.set(id, { record: records.get(id) ?? null, members: [item] });
      order.push(id);
    }
  }

  const stacks = new Map<string, StackInfo>();
  for (const id of order) {
    const bucket = buckets.get(id)!;
    if (bucket.members.length < STACK_MIN_MEMBERS) continue;
    let from = "";
    let to = "";
    for (const m of bucket.members) {
      const iso = m.chat?.updatedAt ?? "";
      if (!iso) continue;
      if (!from || compareIso(iso, from) < 0) from = iso;
      if (!to || compareIso(iso, to) > 0) to = iso;
    }
    stacks.set(id, {
      id,
      folderId: loc.folderId,
      record: bucket.record,
      members: bucket.members,
      updatedFrom: from,
      updatedTo: to,
      pos: bucket.record?.pos ?? null
    });
  }
  if (stacks.size === 0) return items;

  const out: Item[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const id = foldable(item) ? bucketOf.get(item.key) : undefined;
    const info = id === undefined ? undefined : stacks.get(id);
    if (!info) {
      out.push(item);
      continue;
    }
    if (emitted.has(info.id)) continue;
    emitted.add(info.id);
    out.push(stackItem(info, ctx.lang, ctx.t));
    if (expanded?.has(info.id)) {
      info.members.forEach((m, i) => out.push({ ...m, inStack: info.id, stackIndex: i }));
    }
  }
  return out;
}

/**
 * The member keys a selection would contribute to a pile.
 *
 * Folders are dropped (they cannot be stacked) and an already-stacked item is
 * replaced by its contents, so selecting a pile plus two loose chats and
 * hitting 叠放 merges all of them instead of nesting. Order is preserved and
 * duplicates are removed, because `createStack` stores this list verbatim.
 */
export function stackableKeys(items: Item[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (item: Item) => {
    if (item.ref.kind === "folder" || !item.chat) return;
    if (seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item.key);
  };
  for (const item of items) {
    if (item.stack) item.stack.members.forEach(take);
    else take(item);
  }
  return out;
}

/** The piles in a folded list, by id — what `refsToChatUuids` needs to expand one. */
export function stacksOf(items: Item[]): Map<string, StackInfo> {
  const out = new Map<string, StackInfo>();
  for (const item of items) {
    if (item.stack) out.set(item.stack.id, item.stack);
  }
  return out;
}

// --- sorting and grouping ------------------------------------------------------

/**
 * Built once, at module load.
 *
 * `"a".localeCompare(b, locale)` looks free and is not: passing a locale forces
 * a **fresh `Intl.Collator` per call**. Sorting 1296 chats by name is roughly
 * 13 000 comparisons, so the list view was constructing 13 000 pinyin
 * collators every time it rebuilt — which is after every rename, move, sync
 * and settings change, not just on arrival. One shared collator is the same
 * ordering for a fraction of the cost.
 *
 * `numeric` is new〔偏离〕: "第 2 章" now sorts before "第 10 章" rather than
 * after it. Windows Explorer sorts this way and this app is trying to be
 * Explorer, so lexicographic digit order was a bug we had not noticed yet.
 */
export const NAME_COLLATOR = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { numeric: true });

/** Timestamps are ISO 8601, which sorts correctly as plain text — no collator. */
function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareBy(sortKey: SortKey, folders: Folder[], t: T): (a: Item, b: Item) => number {
  // Every comparison used to walk the folder tree to the root, twice. The paths
  // repeat enormously (one folder view is a single path for every row), so they
  // are resolved once each and kept for the length of the sort.
  const paths = new Map<string, string>();
  const pathName = (folderId: string) => {
    let hit = paths.get(folderId);
    if (hit === undefined) {
      hit = folderPathLabel(folders, folderId, t);
      paths.set(folderId, hit);
    }
    return hit;
  };
  return (a, b) => {
    switch (sortKey) {
      case "name":
        return NAME_COLLATOR.compare(a.name, b.name);
      case "updatedAt":
        return compareIso(a.chat?.updatedAt ?? "", b.chat?.updatedAt ?? "");
      case "createdAt":
        return compareIso(a.chat?.createdAt ?? "", b.chat?.createdAt ?? "");
      case "model":
        return compareModel(a.chat?.model ?? null, b.chat?.model ?? null);
      case "location":
        return NAME_COLLATOR.compare(
          pathName(a.chat?.folderId ?? a.folder?.parentId ?? ""),
          pathName(b.chat?.folderId ?? b.folder?.parentId ?? "")
        );
    }
  };
}

/**
 * The direction a key should start in when you first switch to it.
 *
 * Carrying the previous direction over was the real bug behind 「按模型排序…」:
 * the default view is "updated, newest first" — descending — so picking Model
 * inherited descending and opened on Fable, with Haiku buried at the bottom.
 * Explorer resets to each column's natural direction instead, and so do we:
 * dates read newest-first, everything else reads smallest-first.
 */
export function naturalAsc(sortKey: SortKey): boolean {
  return sortKey !== "updatedAt" && sortKey !== "createdAt";
}

/**
 * Sort rank inside the folder block. Unfiled is pinned to the top: it is the
 * inbox, it is where every new chat lands, and letting the collator drop it
 * between two of the user's own folders made it hard to find (「"未归档"应总放
 * 在最前面」). Pinning also means its position never moves when the sort
 * direction flips, which is the point of a pin.
 */
function folderRank(item: Item): number {
  return item.ref.id === UNFILED_ID ? 0 : 1;
}

/** Folders always sort before chats/shortcuts, whatever the key (DESIGN 5.1). */
export function sortItems(items: Item[], view: FolderView, folders: Folder[], t: T): Item[] {
  const cmp = compareBy(view.sortKey, folders, t);
  const dir = view.sortAsc ? 1 : -1;
  return [...items].sort((a, b) => {
    const aFolder = a.ref.kind === "folder" ? 0 : 1;
    const bFolder = b.ref.kind === "folder" ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    if (aFolder === 0) {
      const byRank = folderRank(a) - folderRank(b);
      if (byRank !== 0) return byRank;
      // Folder blocks sort by name regardless of the chat sort key; date keys
      // would leave them in creation order, which reads as random.
      const byName = NAME_COLLATOR.compare(a.name, b.name);
      return view.sortKey === "name" ? dir * byName : byName;
    }
    return dir * cmp(a, b);
  });
}

export interface Group {
  id: string;
  label: string;
  items: Item[];
}

export function groupItems(
  items: Item[],
  group: GroupKey,
  folders: Folder[],
  lang: Lang,
  t: T
): Group[] {
  if (group === "none") return [{ id: "all", label: "", items }];
  const groups = new Map<string, Group>();
  const push = (id: string, label: string, item: Item) => {
    const hit = groups.get(id);
    if (hit) hit.items.push(item);
    else groups.set(id, { id, label, items: [item] });
  };
  for (const item of items) {
    if (item.ref.kind === "folder" || !item.chat) {
      push("folders", t("navFolders"), item);
      continue;
    }
    if (group === "month") {
      const iso = item.chat.updatedAt;
      push(iso.slice(0, 7), monthLabel(iso, lang), item);
    } else if (group === "model") {
      const info = modelInfo(item.chat.model);
      push(info.label, info.label, item);
    } else {
      push(item.chat.folderId, folderPathLabel(folders, item.chat.folderId, t), item);
    }
  }
  return [...groups.values()];
}

// --- misc helpers ---------------------------------------------------------------

/**
 * Chats represented by the given refs. Shortcut refs resolve to their targets,
 * and a stack ref resolves to everything in the pile — selecting a stack and
 * hitting Delete has to mean the chats, because the pile is not a thing that
 * can be deleted on its own.
 *
 * `stacks` is the map of piles currently on screen. It is a parameter rather
 * than a lookup in `data` because an auto-stack has no record to look up.
 */
export function refsToChatUuids(
  refs: ItemRef[],
  data: Snapshot,
  stacks?: ReadonlyMap<string, StackInfo>
): string[] {
  const byId = new Map(data.shortcuts.map((s) => [s.id, s]));
  const uuids = new Set<string>();
  const take = (ref: ItemRef, depth: number) => {
    if (ref.kind === "chat") uuids.add(ref.id);
    else if (ref.kind === "shortcut") {
      const sc = byId.get(ref.id);
      if (sc) uuids.add(sc.targetUuid);
    } else if (ref.kind === "stack" && depth === 0) {
      // Depth-limited rather than recursive: a pile cannot contain a pile, and
      // a bad id must not be able to spin this.
      for (const m of stacks?.get(ref.id)?.members ?? []) take(m.ref, depth + 1);
    }
  };
  for (const ref of refs) take(ref, 0);
  return [...uuids];
}

export function countsFor(ctx: ListContext): Record<VirtualId | "unfiled", number> {
  const { data, hiddenFolders } = ctx;
  const visible = data.chats.filter((c) => !isChatHidden(c, hiddenFolders));
  return {
    unfiled: visible.filter((c) => c.folderId === UNFILED_ID).length,
    recent: Math.min(ctx.recentCount, visible.length),
    flagged: visible.filter((c) => c.flagged).length,
    starred: visible.filter((c) => c.isStarred).length,
    missing: visible.filter((c) => c.status === "missing").length,
    hidden: data.chats.filter((c) => c.hidden).length + data.folders.filter((f) => f.hidden).length
  };
}
