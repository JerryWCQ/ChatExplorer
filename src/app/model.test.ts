/**
 * Pure view-model tests: no IndexedDB, no React — plain Snapshot objects in,
 * item lists out. Mirrors the fixtures used by store.test.ts.
 */

import { expect, test } from "vitest";
import {
  defaultView,
  ROOT_ID,
  UNFILED_ID,
  type Chat,
  type Folder,
  type Shortcut,
  type Stack
} from "../core/schema";
import type { Snapshot } from "../core/store";
import { translator } from "../ui/i18n";
import {
  autoStackId,
  countsFor,
  foldStacks,
  groupItems,
  listItems,
  locationKey,
  makeListContext,
  naturalAsc,
  normalizeForSearch,
  refsToChatUuids,
  sameLocation,
  sortItems,
  stackableKeys,
  stacksOf,
  subtreeIds
} from "./model";

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
    pos: null,
    ...patch
  };
}

function shortcut(id: string, targetUuid: string, folderId: string): Shortcut {
  return { id, targetUuid, folderId, createdAt: 0, pos: null };
}

const BASE_FOLDERS = [folder(ROOT_ID, null, "Folders"), folder(UNFILED_ID, ROOT_ID, "Unfiled")];

function snap(partial: Partial<Snapshot>): Snapshot {
  return { folders: BASE_FOLDERS, chats: [], shortcuts: [], stacks: [], ...partial };
}

function ctxOf(data: Snapshot, recentCount = 50) {
  return makeListContext(data, "en", t, recentCount);
}

// --- normalization ----------------------------------------------------------

test("normalizeForSearch folds fullwidth and case", () => {
  expect(normalizeForSearch("ＡＢＣ１２３")).toBe("abc123");
  expect(normalizeForSearch("Hello　World")).toBe("hello world"); // ideographic space
  expect(normalizeForSearch("中文没变")).toBe("中文没变");
});

// --- locations --------------------------------------------------------------

test("locationKey and sameLocation agree", () => {
  const a = { kind: "folder", folderId: "x" } as const;
  const b = { kind: "search", query: "q", scopeFolderId: "x" } as const;
  expect(locationKey(a)).not.toBe(locationKey(b));
  expect(sameLocation(a, { kind: "folder", folderId: "x" })).toBe(true);
  expect(sameLocation(a, { kind: "folder", folderId: "y" })).toBe(false);
  expect(sameLocation(b, { kind: "search", query: "q", scopeFolderId: "x" })).toBe(true);
});

// --- subtree ----------------------------------------------------------------

test("subtreeIds is inclusive and deep", () => {
  const folders = [
    ...BASE_FOLDERS,
    folder("a", ROOT_ID, "A"),
    folder("b", "a", "B"),
    folder("c", "b", "C"),
    folder("d", ROOT_ID, "D")
  ];
  const ids = subtreeIds(folders, "a");
  expect(ids).toEqual(new Set(["a", "b", "c"]));
});

// --- folder listing ---------------------------------------------------------

test("folder view lists subfolders, chats and live shortcuts only", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("work", ROOT_ID, "Work"), folder("gone", ROOT_ID, "Gone", true)],
    chats: [
      chat("c1", { folderId: "work" }),
      chat("c2", { folderId: "work", hidden: true }),
      chat("c3") // unfiled: must not leak into work
    ],
    shortcuts: [
      shortcut("s1", "c3", "work"),
      shortcut("s2", "c2", "work"), // target hidden → skipped
      shortcut("s3", "missing-target", "work") // vanished → skipped
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: "work" });
  expect(items.map((i) => i.key).sort()).toEqual(["chat:c1", "shortcut:s1"]);

  const root = listItems(ctxOf(data), { kind: "folder", folderId: ROOT_ID });
  // hidden folder does not show among root's children; unfiled does
  expect(root.filter((i) => i.ref.kind === "folder").map((i) => i.ref.id).sort()).toEqual([
    UNFILED_ID,
    "work"
  ]);
});

test("chats inside a hidden folder are invisible everywhere except restore", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("gone", ROOT_ID, "Gone", true), folder("sub", "gone", "Sub")],
    chats: [chat("c1", { folderId: "sub", flagged: true })]
  });
  const ctx = ctxOf(data);
  expect(listItems(ctx, { kind: "virtual", id: "flagged" })).toEqual([]);
  expect(countsFor(ctx).flagged).toBe(0);
  // hidden view shows only the top-level hidden folder, not its subtree
  const hidden = listItems(ctx, { kind: "virtual", id: "hidden" });
  expect(hidden.map((i) => i.key)).toEqual(["folder:gone"]);
});

// --- virtual views ----------------------------------------------------------

test("recent respects recentCount and sorts newest first", () => {
  const data = snap({
    chats: [
      chat("old", { updatedAt: "2026-01-01T00:00:00Z" }),
      chat("mid", { updatedAt: "2026-02-01T00:00:00Z" }),
      chat("new", { updatedAt: "2026-03-01T00:00:00Z" })
    ]
  });
  const items = listItems(ctxOf(data, 2), { kind: "virtual", id: "recent" });
  expect(items.map((i) => i.ref.id)).toEqual(["new", "mid"]);
});

// --- search -----------------------------------------------------------------

test("search folds width, scans notes and honours the scope subtree", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("work", ROOT_ID, "Work"), folder("play", ROOT_ID, "Play")],
    chats: [
      chat("c1", { folderId: "work", remoteName: "ＲＥＰＯＲＴ draft" }),
      chat("c2", { folderId: "play", remoteName: "other", notes: "report notes" }),
      chat("c3", { folderId: "play", remoteName: "unrelated" })
    ]
  });
  const ctx = ctxOf(data);
  const all = listItems(ctx, { kind: "search", query: "report", scopeFolderId: ROOT_ID });
  expect(all.map((i) => i.ref.id).sort()).toEqual(["c1", "c2"]);

  const scoped = listItems(ctx, { kind: "search", query: "report", scopeFolderId: "work" });
  expect(scoped.map((i) => i.ref.id)).toEqual(["c1"]);

  // folder names match too
  const byName = listItems(ctx, { kind: "search", query: "wor", scopeFolderId: ROOT_ID });
  expect(byName.some((i) => i.key === "folder:work")).toBe(true);
});

test("blank query returns nothing", () => {
  const data = snap({ chats: [chat("c1")] });
  expect(listItems(ctxOf(data), { kind: "search", query: "   ", scopeFolderId: ROOT_ID })).toEqual(
    []
  );
});

// --- sorting ----------------------------------------------------------------

test("folders sort first and keep name order under a date sort", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("b", ROOT_ID, "Beta"), folder("a", ROOT_ID, "Alpha")],
    chats: [
      chat("c1", { folderId: ROOT_ID, updatedAt: "2026-01-01T00:00:00Z" }),
      chat("c2", { folderId: ROOT_ID, updatedAt: "2026-02-01T00:00:00Z" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: ROOT_ID });
  const view = { ...defaultView(ROOT_ID), sortKey: "updatedAt" as const, sortAsc: false };
  const sorted = sortItems(items, view, data.folders, t);
  // folder block first (Alpha before Beta despite desc), newest chat first after
  const nonUnfiled = sorted.filter((i) => i.ref.id !== UNFILED_ID);
  expect(nonUnfiled.map((i) => i.ref.id)).toEqual(["a", "b", "c2", "c1"]);
});

test("Unfiled is pinned above the other folders in both directions", () => {
  // "Alpha" collates before "Unfiled", so without the pin it would lead.
  const data = snap({
    folders: [...BASE_FOLDERS, folder("a", ROOT_ID, "Alpha"), folder("z", ROOT_ID, "Zeta")]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: ROOT_ID });
  for (const sortAsc of [true, false]) {
    const sorted = sortItems(items, { ...defaultView(ROOT_ID), sortKey: "name", sortAsc }, data.folders, t);
    expect(sorted[0]?.ref.id).toBe(UNFILED_ID);
  }
});

test("switching sort key adopts that key's natural direction", () => {
  // Dates read newest-first; everything else reads smallest-first.
  expect(naturalAsc("updatedAt")).toBe(false);
  expect(naturalAsc("createdAt")).toBe(false);
  expect(naturalAsc("model")).toBe(true);
  expect(naturalAsc("name")).toBe(true);
  expect(naturalAsc("location")).toBe(true);
});

test("model sort ranks series before version number", () => {
  const data = snap({
    chats: [
      chat("big", { folderId: UNFILED_ID, model: "claude-opus-4-1-20250805" }),
      chat("small", { folderId: UNFILED_ID, model: "claude-haiku-4-5-20260101" }),
      chat("mid", { folderId: UNFILED_ID, model: "claude-3-5-sonnet-20241022" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: UNFILED_ID });
  const sorted = sortItems(
    items,
    { ...defaultView(UNFILED_ID), sortKey: "model", sortAsc: naturalAsc("model") },
    data.folders,
    t
  );
  // Haiku 4.5 below Sonnet 3.5 below Opus 4.1 — size wins over version number.
  expect(sorted.map((i) => i.ref.id)).toEqual(["small", "mid", "big"]);
});

test("flipping sortAsc reverses chats but not folders", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("a", ROOT_ID, "Alpha"), folder("b", ROOT_ID, "Beta")],
    chats: [
      chat("c1", { folderId: ROOT_ID, updatedAt: "2026-01-01T00:00:00Z" }),
      chat("c2", { folderId: ROOT_ID, updatedAt: "2026-02-01T00:00:00Z" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: ROOT_ID });
  const asc = sortItems(
    items,
    { ...defaultView(ROOT_ID), sortKey: "updatedAt", sortAsc: true },
    data.folders,
    t
  );
  const desc = sortItems(
    items,
    { ...defaultView(ROOT_ID), sortKey: "updatedAt", sortAsc: false },
    data.folders,
    t
  );
  const chatsOf = (list: typeof asc) =>
    list.filter((i) => i.ref.kind === "chat").map((i) => i.ref.id);
  expect(chatsOf(asc)).toEqual(["c1", "c2"]);
  expect(chatsOf(desc)).toEqual(["c2", "c1"]);
  const foldersOf = (list: typeof asc) =>
    list.filter((i) => i.ref.kind === "folder" && i.ref.id !== UNFILED_ID).map((i) => i.ref.id);
  expect(foldersOf(asc)).toEqual(foldersOf(desc));
});

/**
 * The name sort moved from a per-call `localeCompare(…, locale)` to one shared
 * `Intl.Collator` — thirteen thousand collator constructions per sort was the
 * single most expensive thing in the list view. `numeric` came along with it,
 * which is a behaviour change worth pinning: lexicographic order puts "10"
 * before "2", and Explorer does not.
 */
test("names sort naturally, so chapter 2 comes before chapter 10", () => {
  const data = snap({
    chats: [
      chat("c10", { displayName: "Chapter 10" }),
      chat("c2", { displayName: "Chapter 2" }),
      chat("c1", { displayName: "Chapter 1" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: UNFILED_ID });
  const sorted = sortItems(
    items,
    { ...defaultView(UNFILED_ID), sortKey: "name", sortAsc: true },
    data.folders,
    t
  );
  expect(sorted.map((i) => i.name)).toEqual(["Chapter 1", "Chapter 2", "Chapter 10"]);
});

test("date sorting is unaffected by the collator change", () => {
  const data = snap({
    chats: [
      chat("c1", { createdAt: "2026-01-02T00:00:00Z" }),
      chat("c2", { createdAt: "2026-01-10T00:00:00Z" }),
      chat("c3", { createdAt: "2026-01-01T00:00:00Z" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: UNFILED_ID });
  const sorted = sortItems(
    items,
    { ...defaultView(UNFILED_ID), sortKey: "createdAt", sortAsc: true },
    data.folders,
    t
  );
  expect(sorted.map((i) => i.ref.id)).toEqual(["c3", "c1", "c2"]);
});

// --- grouping ---------------------------------------------------------------

test("group none yields a single unlabeled group", () => {
  const data = snap({ chats: [chat("c1")] });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: UNFILED_ID });
  const groups = groupItems(items, "none", data.folders, "en", t);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.label).toBe("");
});

test("month grouping splits by updatedAt and keeps folders separate", () => {
  const data = snap({
    folders: [...BASE_FOLDERS, folder("a", ROOT_ID, "Alpha")],
    chats: [
      chat("c1", { folderId: ROOT_ID, updatedAt: "2026-01-15T00:00:00Z" }),
      chat("c2", { folderId: ROOT_ID, updatedAt: "2026-02-15T00:00:00Z" }),
      chat("c3", { folderId: ROOT_ID, updatedAt: "2026-02-20T00:00:00Z" })
    ]
  });
  const items = listItems(ctxOf(data), { kind: "folder", folderId: ROOT_ID });
  const groups = groupItems(items, "month", data.folders, "en", t);
  const byId = new Map(groups.map((g) => [g.id, g.items.length]));
  expect(byId.get("folders")).toBe(2); // Alpha + Unfiled
  expect(byId.get("2026-01")).toBe(1);
  expect(byId.get("2026-02")).toBe(2);
});

// --- refs -------------------------------------------------------------------

test("refsToChatUuids resolves shortcuts and dedupes", () => {
  const data = snap({
    chats: [chat("c1")],
    shortcuts: [shortcut("s1", "c1", ROOT_ID)]
  });
  const uuids = refsToChatUuids(
    [
      { kind: "chat", id: "c1" },
      { kind: "shortcut", id: "s1" },
      { kind: "shortcut", id: "nope" },
      { kind: "folder", id: ROOT_ID }
    ],
    data
  );
  expect(uuids).toEqual(["c1"]);
});

// --- stacks -----------------------------------------------------------------
//
// Timestamps here deliberately omit the trailing "Z": `dayKey` partitions by
// the *local* calendar day, so a UTC fixture would land in a different pile
// depending on the machine's timezone.

function stackRec(id: string, folderId: string, members: string[], name: string | null = null): Stack {
  return { id, folderId, members, name, createdAt: 0, pos: null };
}

const STACK_FOLDERS = [...BASE_FOLDERS, folder("f1", ROOT_ID, "Work")];

function inFolder(uuid: string, updatedAt: string): Chat {
  return chat(uuid, { folderId: "f1", updatedAt });
}

const iconView = { ...defaultView("f1"), sortKey: "updatedAt" as const, sortAsc: false };

function foldedIn(data: Snapshot, view = iconView, expanded?: Set<string>) {
  const ctx = ctxOf(data);
  const loc = { kind: "folder", folderId: "f1" } as const;
  const sorted = sortItems(listItems(ctx, loc), view, data.folders, t);
  return foldStacks(sorted, ctx, loc, view, expanded);
}

test("a stored stack folds its members into one pile named for their date range", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [
      inFolder("c1", "2026-03-01T10:00:00"),
      inFolder("c2", "2026-03-03T10:00:00"),
      inFolder("c3", "2026-03-05T10:00:00")
    ],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"])]
  });
  const items = foldedIn(data);
  expect(items.map((i) => i.key)).toEqual(["chat:c3", "stack:st1"]);

  const pile = items[1]!;
  expect(pile.stack?.members.map((m) => m.key)).toEqual(["chat:c2", "chat:c1"]);
  // The representative is the newest member — the card drawn on top.
  expect(pile.chat?.uuid).toBe("c2");
  expect(pile.name).toMatch(/^Mar 1.* – Mar 3/);
});

test("a typed name wins over the derived date range", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [inFolder("c1", "2026-03-01T10:00:00"), inFolder("c2", "2026-03-03T10:00:00")],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"], "Taxes")]
  });
  expect(foldedIn(data)[0]?.name).toBe("Taxes");
});

test("a stack left with one present member renders loose instead of as a pile", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [inFolder("c1", "2026-03-01T10:00:00")],
    // c2 moved away and c3 was purged; neither is in this folder any more.
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2", "chat:c3"])]
  });
  expect(foldedIn(data).map((i) => i.key)).toEqual(["chat:c1"]);
});

test("expanding a stack leaves the pile in its slot and lays the members after it", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [
      inFolder("c1", "2026-03-01T10:00:00"),
      inFolder("c2", "2026-03-03T10:00:00"),
      inFolder("c3", "2026-03-05T10:00:00")
    ],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"])]
  });
  const items = foldedIn(data, iconView, new Set(["st1"]));
  expect(items.map((i) => i.key)).toEqual(["chat:c3", "stack:st1", "chat:c2", "chat:c1"]);
});

test("auto-stacking by day supersedes stored stacks and invents its own piles", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [
      inFolder("c1", "2026-03-01T09:00:00"),
      inFolder("c2", "2026-03-01T22:00:00"),
      inFolder("c3", "2026-03-02T09:00:00")
    ],
    // Crosses the day boundary on purpose: while auto-stacking is on it must be
    // ignored entirely, not merged with the derived piles.
    stacks: [stackRec("st1", "f1", ["chat:c2", "chat:c3"])]
  });
  const items = foldedIn(data, { ...iconView, autoStack: "day" });
  // 2026-03-02 has a single chat, so it stays loose rather than becoming a pile of one.
  expect(items.map((i) => i.key)).toEqual(["chat:c3", `stack:${autoStackId("2026-03-01")}`]);
  const pile = items[1]!;
  expect(pile.stack?.id).toBe(autoStackId("2026-03-01"));
  expect(pile.stack?.record).toBeNull();
  expect(pile.stack?.members.map((m) => m.key)).toEqual(["chat:c2", "chat:c1"]);
});

test("nothing folds in the details view", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [inFolder("c1", "2026-03-01T10:00:00"), inFolder("c2", "2026-03-03T10:00:00")],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"])]
  });
  const items = foldedIn(data, { ...iconView, mode: "details" });
  expect(items.map((i) => i.key)).toEqual(["chat:c2", "chat:c1"]);
});

test("a folder is never swallowed by a pile", () => {
  const data = snap({
    folders: [...STACK_FOLDERS, folder("f2", "f1", "Sub")],
    chats: [inFolder("c1", "2026-03-01T10:00:00"), inFolder("c2", "2026-03-01T11:00:00")],
    stacks: [stackRec("st1", "f1", ["folder:f2", "chat:c1", "chat:c2"])]
  });
  const items = foldedIn(data);
  expect(items[0]?.key).toBe("folder:f2");
  expect(items[1]?.stack?.members.map((m) => m.key)).toEqual(["chat:c2", "chat:c1"]);
});

test("a stack ref resolves to every chat in the pile", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [inFolder("c1", "2026-03-01T10:00:00"), inFolder("c2", "2026-03-03T10:00:00")],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"])]
  });
  const items = foldedIn(data);
  const uuids = refsToChatUuids([{ kind: "stack", id: "st1" }], data, stacksOf(items));
  expect(uuids.sort()).toEqual(["c1", "c2"]);
  // Without the map there is nothing to expand, and it must not throw.
  expect(refsToChatUuids([{ kind: "stack", id: "st1" }], data)).toEqual([]);
});

test("stacking a pile together with a loose chat merges rather than nests", () => {
  const data = snap({
    folders: STACK_FOLDERS,
    chats: [
      inFolder("c1", "2026-03-01T10:00:00"),
      inFolder("c2", "2026-03-03T10:00:00"),
      inFolder("c3", "2026-03-05T10:00:00")
    ],
    stacks: [stackRec("st1", "f1", ["chat:c1", "chat:c2"])]
  });
  // The folded list is [c3, pile(c2, c1)]. Selecting all of it and stacking
  // must yield the three chats, not a pile holding a pile.
  expect(stackableKeys(foldedIn(data))).toEqual(["chat:c3", "chat:c2", "chat:c1"]);
});

test("folders are never stackable and duplicates collapse", () => {
  const data = snap({
    folders: [...STACK_FOLDERS, folder("f2", "f1", "sub")],
    chats: [inFolder("c1", "2026-03-01T10:00:00")]
  });
  const items = foldedIn(data);
  expect(items.some((i) => i.ref.kind === "folder")).toBe(true);
  expect(stackableKeys([...items, ...items])).toEqual(["chat:c1"]);
});

// --- counts -----------------------------------------------------------------

test("countsFor tallies virtual views over visible chats", () => {
  const data = snap({
    chats: [
      chat("c1", { flagged: true }),
      chat("c2", { isStarred: true }),
      chat("c3", { status: "missing" }),
      chat("c4", { hidden: true, flagged: true })
    ]
  });
  const counts = countsFor(ctxOf(data, 10));
  expect(counts.unfiled).toBe(3);
  expect(counts.flagged).toBe(1);
  expect(counts.starred).toBe(1);
  expect(counts.missing).toBe(1);
  expect(counts.hidden).toBe(1);
  expect(counts.recent).toBe(3);
});
