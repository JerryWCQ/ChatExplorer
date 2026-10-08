import { DB_NAME, DB_VERSION, ROOT_ID, STORE, UNFILED_ID, type Folder } from "./schema";

let dbPromise: Promise<IDBDatabase> | null = null;

function createV1(db: IDBDatabase): void {
  const folders = db.createObjectStore(STORE.folders, { keyPath: "id" });
  folders.createIndex("parentId", "parentId");

  const chats = db.createObjectStore(STORE.chats, { keyPath: "uuid" });
  chats.createIndex("folderId", "folderId");
  chats.createIndex("updatedAt", "updatedAt");

  const shortcuts = db.createObjectStore(STORE.shortcuts, { keyPath: "id" });
  shortcuts.createIndex("folderId", "folderId");
  shortcuts.createIndex("targetUuid", "targetUuid");

  db.createObjectStore(STORE.transactions, { keyPath: "seq", autoIncrement: true });
  db.createObjectStore(STORE.meta, { keyPath: "key" });

  const now = Date.now();
  const root: Folder = {
    id: ROOT_ID,
    parentId: null,
    name: "ChatExplorer",
    createdAt: now,
    hidden: false,
    pos: null
  };
  const unfiled: Folder = { ...root, id: UNFILED_ID, parentId: ROOT_ID, name: "Unfiled" };
  folders.add(root);
  folders.add(unfiled);
}

/**
 * Backfills the local-only fields added in v2. Records written by v1 predate
 * `hidden`/`flagged`/`pos`, and `undefined` would break every `.filter(c =>
 * !c.hidden)` in subtle ways, so they are normalised once here.
 */
function migrateToV2(db: IDBDatabase, t: IDBTransaction): void {
  db.createObjectStore(STORE.views, { keyPath: "folderId" });

  const backfill = (store: string, defaults: Record<string, unknown>) => {
    const req = t.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as Record<string, unknown>;
      let changed = false;
      for (const [key, value] of Object.entries(defaults)) {
        if (row[key] === undefined) {
          row[key] = value;
          changed = true;
        }
      }
      if (changed) cursor.update(row);
      cursor.continue();
    };
  };

  backfill(STORE.folders, { hidden: false, pos: null });
  backfill(STORE.chats, { hidden: false, flagged: false, pos: null });
  backfill(STORE.shortcuts, { pos: null });
}

/**
 * v3: the stacks store. Nothing to backfill — stacks are new, and no existing
 * record gained a field, precisely because a stack holds references *to* items
 * rather than a flag *on* them.
 */
function migrateToV3(db: IDBDatabase): void {
  const stacks = db.createObjectStore(STORE.stacks, { keyPath: "id" });
  stacks.createIndex("folderId", "folderId");
}

/**
 * v4: the AI organizer's sessions and turns. Turns use a compound key so a
 * session's conversation is one key-range read, in order, with no index, and
 * truncating it for a rewind is one key-range delete.
 */
function migrateToV4(db: IDBDatabase): void {
  db.createObjectStore(STORE.agentSessions, { keyPath: "id" });
  db.createObjectStore(STORE.agentTurns, { keyPath: ["sessionId", "idx"] });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const t = req.transaction!;
      if (event.oldVersion < 1) createV1(db);
      if (event.oldVersion < 2) migrateToV2(db, t);
      if (event.oldVersion < 3) migrateToV3(db);
      if (event.oldVersion < 4) migrateToV4(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
  const result = await fn(t);
  await done;
  return result;
}

export const idb = {
  get: <T>(t: IDBTransaction, store: string, key: IDBValidKey) =>
    promisify<T | undefined>(t.objectStore(store).get(key) as IDBRequest<T | undefined>),
  getAll: <T>(t: IDBTransaction, store: string) =>
    promisify<T[]>(t.objectStore(store).getAll() as IDBRequest<T[]>),
  getAllByIndex: <T>(t: IDBTransaction, store: string, index: string, key: IDBValidKey) =>
    promisify<T[]>(t.objectStore(store).index(index).getAll(key) as IDBRequest<T[]>),
  put: (t: IDBTransaction, store: string, value: unknown) =>
    promisify(t.objectStore(store).put(value as never)),
  add: (t: IDBTransaction, store: string, value: unknown) =>
    promisify(t.objectStore(store).add(value as never)),
  del: (t: IDBTransaction, store: string, key: IDBValidKey) =>
    promisify(t.objectStore(store).delete(key)),
  count: (t: IDBTransaction, store: string) => promisify(t.objectStore(store).count())
};

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return tx([STORE.meta], "readonly", async (t) => {
    const row = await idb.get<{ key: string; value: T }>(t, STORE.meta, key);
    return row?.value;
  });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await tx([STORE.meta], "readwrite", (t) => idb.put(t, STORE.meta, { key, value }));
}
