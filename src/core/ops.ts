import { idb, tx } from "./db";
import { META_KEY, STORE, type Chat, type Folder, type Shortcut, type Stack } from "./schema";
import type { MessageKey, Vars } from "../ui/i18n";

/**
 * Undo entries are persisted, so their labels must survive a language change:
 * storing "Delete 4 chats" would still read English after the user switches to
 * 中文, and would be wrong forever. We store the message key plus its variables
 * and render at display time instead.
 *
 * The i18n import is type-only and therefore erased at build time, so `core`
 * keeps its zero runtime dependency on `ui`.
 */
export interface OpLabel {
  key: MessageKey;
  vars?: Vars;
}

/** Fields of a Chat that are local-only and therefore user-editable + undoable. */
export type ChatPatch = Partial<
  Pick<Chat, "folderId" | "displayName" | "notes" | "flagged" | "hidden" | "pos">
>;

/**
 * The complete set of primitive mutations. Every user action composes these, so
 * undo only ever needs to invert nine shapes. Sync writes bypass this layer —
 * pulling from the server is not a user action and must not land on the stack.
 *
 * `chat.put` / `chat.del` were added for 〔2026-09-19 第三批〕: permanently
 * deleting a folder now destroys its contents rather than re-filing them, and
 * destroying a chat record needs a primitive that can drop the whole row — and,
 * so the step stays undoable, one that can put an entire row back.
 *
 * `stack.put` / `stack.del` were added for 〔2026-09-20 叠放〕. Folding a
 * selection into a pile is a deliberate act on content, so it belongs in the
 * history panel next to moving and deleting — not in the view-state bucket with
 * sort order. A stack holds only references, so these two shapes cover
 * creating, renaming, adding, removing and dissolving alike: every one of them
 * is "write the whole record" or "drop it".
 */
export type Op =
  | { t: "folder.put"; folder: Folder }
  | { t: "folder.del"; id: string }
  | { t: "chat.put"; chat: Chat }
  | { t: "chat.patch"; uuid: string; patch: ChatPatch }
  | { t: "chat.del"; uuid: string }
  | { t: "shortcut.put"; shortcut: Shortcut }
  | { t: "shortcut.del"; id: string }
  | { t: "stack.put"; stack: Stack }
  | { t: "stack.del"; id: string };

export interface Transaction {
  seq: number;
  ts: number;
  label: OpLabel;
  ops: Op[];
  inverse: Op[];
}

const TXN_STORES = [
  STORE.folders,
  STORE.chats,
  STORE.shortcuts,
  STORE.stacks,
  STORE.transactions,
  STORE.meta
];
/**
 * 200 → 1000 on 2026-09-24 for the AI organizer: one organizing session can
 * easily run past 200 batches, and every batch is a node the user may want to
 * rewind to. An agent node whose step has fallen off the end is shown as no
 * longer rewindable rather than silently doing nothing.
 */
export const MAX_LOG = 1000;

async function applyOp(t: IDBTransaction, op: Op): Promise<void> {
  switch (op.t) {
    case "folder.put":
      await idb.put(t, STORE.folders, op.folder);
      return;
    case "folder.del":
      await idb.del(t, STORE.folders, op.id);
      return;
    case "chat.put":
      await idb.put(t, STORE.chats, op.chat);
      return;
    case "chat.patch": {
      const chat = await idb.get<Chat>(t, STORE.chats, op.uuid);
      if (!chat) return;
      await idb.put(t, STORE.chats, { ...chat, ...op.patch });
      return;
    }
    case "chat.del":
      await idb.del(t, STORE.chats, op.uuid);
      return;
    case "shortcut.put":
      await idb.put(t, STORE.shortcuts, op.shortcut);
      return;
    case "shortcut.del":
      await idb.del(t, STORE.shortcuts, op.id);
      return;
    case "stack.put":
      await idb.put(t, STORE.stacks, op.stack);
      return;
    case "stack.del":
      await idb.del(t, STORE.stacks, op.id);
      return;
  }
}

/** Must be called against the state as it exists immediately before `op` applies. */
async function inverseOf(t: IDBTransaction, op: Op): Promise<Op | null> {
  switch (op.t) {
    case "folder.put": {
      const prev = await idb.get<Folder>(t, STORE.folders, op.folder.id);
      return prev ? { t: "folder.put", folder: prev } : { t: "folder.del", id: op.folder.id };
    }
    case "folder.del": {
      const prev = await idb.get<Folder>(t, STORE.folders, op.id);
      return prev ? { t: "folder.put", folder: prev } : null;
    }
    case "chat.put": {
      const prev = await idb.get<Chat>(t, STORE.chats, op.chat.uuid);
      return prev ? { t: "chat.put", chat: prev } : { t: "chat.del", uuid: op.chat.uuid };
    }
    case "chat.del": {
      const prev = await idb.get<Chat>(t, STORE.chats, op.uuid);
      return prev ? { t: "chat.put", chat: prev } : null;
    }
    case "chat.patch": {
      const prev = await idb.get<Chat>(t, STORE.chats, op.uuid);
      if (!prev) return null;
      const patch: ChatPatch = {};
      // Every ChatPatch key is a keyof Chat, so copying the previous value
      // across is sound; TS just cannot express that without per-key narrowing.
      const sink = patch as Record<string, unknown>;
      for (const key of Object.keys(op.patch) as (keyof ChatPatch)[]) sink[key] = prev[key];
      return { t: "chat.patch", uuid: op.uuid, patch };
    }
    case "shortcut.put": {
      const prev = await idb.get<Shortcut>(t, STORE.shortcuts, op.shortcut.id);
      return prev ? { t: "shortcut.put", shortcut: prev } : { t: "shortcut.del", id: op.shortcut.id };
    }
    case "shortcut.del": {
      const prev = await idb.get<Shortcut>(t, STORE.shortcuts, op.id);
      return prev ? { t: "shortcut.put", shortcut: prev } : null;
    }
    case "stack.put": {
      const prev = await idb.get<Stack>(t, STORE.stacks, op.stack.id);
      return prev ? { t: "stack.put", stack: prev } : { t: "stack.del", id: op.stack.id };
    }
    case "stack.del": {
      const prev = await idb.get<Stack>(t, STORE.stacks, op.id);
      return prev ? { t: "stack.put", stack: prev } : null;
    }
  }
}

async function readCursor(t: IDBTransaction): Promise<number> {
  const row = await idb.get<{ key: string; value: number }>(t, STORE.meta, META_KEY.undoCursor);
  return row?.value ?? 0;
}

function writeCursor(t: IDBTransaction, value: number): Promise<unknown> {
  return idb.put(t, STORE.meta, { key: META_KEY.undoCursor, value });
}

function deleteRange(t: IDBTransaction, range: IDBKeyRange): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = t.objectStore(STORE.transactions).delete(range);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function seekTransaction(
  t: IDBTransaction,
  range: IDBKeyRange,
  direction: IDBCursorDirection
): Promise<Transaction | null> {
  return new Promise((resolve, reject) => {
    const req = t.objectStore(STORE.transactions).openCursor(range, direction);
    req.onsuccess = () => resolve((req.result?.value as Transaction) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Apply `ops` as one undoable unit. Inverses are computed op-by-op against the
 * intermediate state, since an earlier op in the same batch can change what a
 * later one is undoing.
 */
export async function commit(label: OpLabel, ops: Op[]): Promise<number> {
  if (ops.length === 0) return 0;
  return tx(TXN_STORES, "readwrite", async (t) => {
    const inverse: Op[] = [];
    for (const op of ops) {
      const inv = await inverseOf(t, op);
      if (inv) inverse.push(inv);
      await applyOp(t, op);
    }

    const cursor = await readCursor(t);
    // A fresh action invalidates anything that was undone.
    await deleteRange(t, IDBKeyRange.lowerBound(cursor, true));

    const record = { ts: Date.now(), label, ops, inverse: inverse.reverse() };
    const seq = (await idb.add(t, STORE.transactions, record)) as number;
    await writeCursor(t, seq);

    const oldest = await seekTransaction(t, IDBKeyRange.upperBound(seq), "next");
    if (oldest && seq - oldest.seq >= MAX_LOG) {
      await deleteRange(t, IDBKeyRange.upperBound(seq - MAX_LOG));
    }
    return seq;
  });
}

/**
 * Log entries written before labels became structured hold a bare English
 * string. Rather than migrate the store, we map those onto the one key that can
 * render without knowing what the action was — the history stays usable and the
 * stale text never reaches the UI.
 */
function readLabel(label: OpLabel | string): OpLabel {
  return typeof label === "string" ? { key: "opLegacy" } : label;
}

/** Returns the label of the undone action, or null if there was nothing to undo. */
export async function undo(): Promise<OpLabel | null> {
  return tx(TXN_STORES, "readwrite", async (t) => {
    const cursor = await readCursor(t);
    if (cursor === 0) return null;
    const record = await idb.get<Transaction>(t, STORE.transactions, cursor);
    if (!record) return null;
    for (const op of record.inverse) await applyOp(t, op);
    const prev = await seekTransaction(t, IDBKeyRange.upperBound(cursor, true), "prev");
    await writeCursor(t, prev?.seq ?? 0);
    return readLabel(record.label);
  });
}

export async function redo(): Promise<OpLabel | null> {
  return tx(TXN_STORES, "readwrite", async (t) => {
    const cursor = await readCursor(t);
    const next = await seekTransaction(t, IDBKeyRange.lowerBound(cursor, true), "next");
    if (!next) return null;
    for (const op of next.ops) await applyOp(t, op);
    await writeCursor(t, next.seq);
    return readLabel(next.label);
  });
}

export interface HistoryState {
  undoLabel: OpLabel | null;
  redoLabel: OpLabel | null;
}

/**
 * One row of the history panel. The `ops`/`inverse` arrays are deliberately
 * stripped: a single step can carry thousands of primitives (purging a big
 * folder), and the panel only ever needs to name it and count it.
 */
export interface HistoryEntry {
  seq: number;
  ts: number;
  label: OpLabel;
  /** Primitive writes in the step — "how big was this?" at a glance. */
  size: number;
}

export interface HistoryLog {
  /** Oldest first, which is the order the actions happened in. */
  entries: HistoryEntry[];
  /**
   * Seq of the newest entry that is currently applied; 0 means the log is fully
   * wound back. Everything above it has been undone and is waiting to be redone.
   */
  cursor: number;
}

export async function historyLog(): Promise<HistoryLog> {
  return tx([STORE.transactions, STORE.meta], "readonly", async (t) => {
    const rows = await idb.getAll<Transaction>(t, STORE.transactions);
    const cursor = await readCursor(t);
    return {
      entries: rows
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({
          seq: r.seq,
          ts: r.ts,
          label: readLabel(r.label),
          size: r.ops.length
        })),
      cursor
    };
  });
}

/**
 * Wind the log to `target` — the seq that should end up being the newest
 * applied step, or 0 for "before everything".
 *
 * This is the whole of 「支持回到某个动作之前」 and of 「取消回退」: both are the
 * same move, they just point in opposite directions. Going down replays each
 * step's inverse newest-first; going up replays each step's ops oldest-first.
 * Nothing is added to the log on the way — the cursor **is** the record of
 * where you are, which is why jumping back and then forward again lands on
 * exactly the state you left, with no pile of bookkeeping entries in between.
 *
 * Returns the number of steps moved, negative when winding back.
 */
export async function jumpTo(target: number): Promise<number> {
  return tx(TXN_STORES, "readwrite", async (t) => {
    const rows = await sortedRows(t);
    // Guard: an unknown seq would silently strand the cursor somewhere no entry
    // describes, and every later undo would then be computed from the wrong end.
    if (target !== 0 && !rows.some((r) => r.seq === target)) return 0;
    return windTo(t, rows, target);
  });
}

/**
 * Wind the log to the state immediately **before** step `seq` — the AI
 * organizer's rewind (「rewind 到某个节点前」).
 *
 * This is `jumpTo(predecessor)`, but the predecessor has to be found here,
 * inside the transaction, because the caller cannot know it: the user may have
 * made manual edits between two agent steps, and the step right before `seq`
 * may have fallen off the end of the log. In the second case the target is 0,
 * which is still exact — the log then starts at `seq`, so "wind back to before
 * everything that is left" undoes precisely `seq` and what follows.
 *
 * Returns null when `seq` is no longer in the log: evicted past MAX_LOG, or
 * discarded because the user undid it and then did something else. Such a
 * node cannot be rewound to, and the caller must say so rather than guess.
 */
export async function jumpBefore(seq: number): Promise<number | null> {
  return tx(TXN_STORES, "readwrite", async (t) => {
    const rows = await sortedRows(t);
    const at = rows.findIndex((r) => r.seq === seq);
    if (at === -1) return null;
    return windTo(t, rows, rows[at - 1]?.seq ?? 0);
  });
}

/**
 * The shape of the log without its payloads: which steps exist and where the
 * cursor stands. Keys only, so it stays cheap at MAX_LOG entries — the agent
 * panel asks for it after every write to decide which nodes are still
 * rewindable, and `historyLog` would drag every op of every step along.
 */
export async function logIndex(): Promise<{ seqs: number[]; cursor: number }> {
  return tx([STORE.transactions, STORE.meta], "readonly", async (t) => {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = t.objectStore(STORE.transactions).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return {
      seqs: (keys as number[]).sort((a, b) => a - b),
      cursor: await readCursor(t)
    };
  });
}

async function sortedRows(t: IDBTransaction): Promise<Transaction[]> {
  return (await idb.getAll<Transaction>(t, STORE.transactions)).sort((a, b) => a.seq - b.seq);
}

async function windTo(t: IDBTransaction, rows: Transaction[], target: number): Promise<number> {
  const cursor = await readCursor(t);
  if (target === cursor) return 0;

  if (target < cursor) {
    const back = rows.filter((r) => r.seq > target && r.seq <= cursor).reverse();
    for (const record of back) {
      for (const op of record.inverse) await applyOp(t, op);
    }
    await writeCursor(t, target);
    return -back.length;
  }

  const forward = rows.filter((r) => r.seq > cursor && r.seq <= target);
  for (const record of forward) {
    for (const op of record.ops) await applyOp(t, op);
  }
  await writeCursor(t, target);
  return forward.length;
}

export async function historyState(): Promise<HistoryState> {
  return tx([STORE.transactions, STORE.meta], "readonly", async (t) => {
    const cursor = await readCursor(t);
    const current = cursor ? await idb.get<Transaction>(t, STORE.transactions, cursor) : undefined;
    const next = await seekTransaction(t, IDBKeyRange.lowerBound(cursor, true), "next");
    return {
      undoLabel: current ? readLabel(current.label) : null,
      redoLabel: next ? readLabel(next.label) : null
    };
  });
}
