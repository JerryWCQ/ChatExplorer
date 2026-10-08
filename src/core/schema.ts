export const DB_NAME = "chat-explorer";
/**
 * v2 added local hidden/flagged flags, free-layout positions, and the views
 * store. v3 added the stacks store. v4 added the AI organizer's two stores:
 * its sessions and their turns.
 */
export const DB_VERSION = 4;

export const ROOT_ID = "root";
export const UNFILED_ID = "unfiled";

/** Folders the user may not rename, move, or delete. */
export const SYSTEM_FOLDER_IDS: readonly string[] = [ROOT_ID, UNFILED_ID];

/** Free-layout coordinate, relative to the folder's canvas origin. */
export interface Pos {
  x: number;
  y: number;
}

export interface Folder {
  id: string;
  /** null only for ROOT_ID. */
  parentId: string | null;
  name: string;
  createdAt: number;
  /**
   * Local soft-delete. A hidden folder keeps its whole subtree intact so that
   * restoring it is a single flip rather than a re-filing job.
   */
  hidden: boolean;
  /** Free-layout position within the parent folder; null until dragged. */
  pos: Pos | null;
}

/**
 * A conversation on claude.ai, mirrored locally. `folderId` is its single true
 * location; additional placements are Shortcut records.
 */
export interface Chat {
  uuid: string;
  folderId: string;
  /** Local override. Falls back to remoteName when null. */
  displayName: string | null;
  remoteName: string;
  summary: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** Server-side star. Read-only here: we never write back to claude.ai. */
  isStarred: boolean;
  isTemporary: boolean;
  projectUuid: string | null;
  lastReadAt: string | null;
  /** "missing" = present locally but no longer returned by the server. */
  status: "active" | "missing";
  firstSeenAt: number;
  lastSyncedAt: number;
  notes: string;
  /** Local-only mark, the writable counterpart to the read-only isStarred. */
  flagged: boolean;
  /** Local soft-delete. Sync must never clear this, or hidden chats resurrect. */
  hidden: boolean;
  pos: Pos | null;
}

/**
 * Fields a full sync must preserve rather than overwrite. Anything not listed
 * here is owned by the server and gets replaced on every sync.
 */
export const LOCAL_CHAT_FIELDS = [
  "folderId",
  "displayName",
  "notes",
  "flagged",
  "hidden",
  "pos",
  "firstSeenAt"
] as const satisfies readonly (keyof Chat)[];

/** An alias pointing at a Chat from another folder. */
export interface Shortcut {
  id: string;
  targetUuid: string;
  folderId: string;
  createdAt: number;
  pos: Pos | null;
}

/**
 * A macOS-style stack: several items in one folder drawn as a single fanned
 * pile until you expand it.
 *
 * **A stack is not a folder and must never become one.** The hard invariant of
 * this app is that a chat has exactly one true location; stacking is a purely
 * *visual* fold applied inside the folder the chats already live in, so
 * `Chat.folderId` is untouched by every operation here. That is also what macOS
 * does — a stack on the Desktop leaves the files on the Desktop. Getting this
 * wrong would turn stacks into a second, parallel filing system with its own
 * breadcrumb, its own cascade-delete rules and its own shortcut semantics.
 *
 * Consequences worth stating, because they are load-bearing:
 *  - Stacks belong to one folder and show up only in that folder's icon view.
 *    Virtual lists (recent, flagged, …) and search are cross-folder views of
 *    chats, so a per-folder fold has no meaning there and is ignored.
 *  - `members` may name items that have since moved away, been deleted or been
 *    purged. That is fine and deliberate: membership is resolved at *read*
 *    time against what the folder actually contains, so a stale id simply does
 *    not render. No mutation anywhere else in the app has to know stacks exist.
 */
export interface Stack {
  id: string;
  /** The folder whose icon view draws this stack. */
  folderId: string;
  /**
   * `null` = derive the name from the members' date range, which is the user's
   * 「叠放后的名称可以是时间段」. A non-null value is a name they typed.
   */
  name: string | null;
  /**
   * Item keys (`chat:<uuid>` / `shortcut:<id>`) — the same identity currency
   * the selection model and React keys already use, so membership tests are a
   * plain `Set.has` against `item.key`.
   */
  members: string[];
  createdAt: number;
  pos: Pos | null;
}

/** Below this a stack is pointless, so it dissolves itself rather than linger. */
export const STACK_MIN_MEMBERS = 2;

export const STORE = {
  folders: "folders",
  chats: "chats",
  shortcuts: "shortcuts",
  stacks: "stacks",
  transactions: "transactions",
  meta: "meta",
  views: "views",
  /** AI organizer conversations: one row per session, metadata only. */
  agentSessions: "agentSessions",
  /**
   * One row per turn, keyed `[sessionId, idx]`. Kept apart from the session
   * row so that appending a turn writes one small record instead of rewriting
   * a whole conversation — a long organizing run carries megabytes of tool
   * output, and the session list must not have to load any of it.
   */
  agentTurns: "agentTurns"
} as const;

export const META_KEY = {
  orgId: "orgId",
  lastSyncAt: "lastSyncAt",
  /** Seq of the newest applied transaction; anything above it is redoable. */
  undoCursor: "undoCursor",
  settings: "settings",
  /**
   * The AI organizer's connection (endpoint, key, model). Its own key rather
   * than a field of `settings`, so that whatever one day exports or syncs the
   * settings object cannot carry an API key along by accident.
   */
  aiConfig: "aiConfig"
} as const;

// --- per-folder view state -------------------------------------------------

export type ViewMode = "icons" | "details" | "free";
export type SortKey = "name" | "updatedAt" | "createdAt" | "model" | "location";
export type GroupKey = "none" | "month" | "model" | "location";
export type Density = "compact" | "comfortable";

/**
 * Remembered per folder. Deliberately stored outside the folder record and
 * outside the undo log: changing a sort order should not consume an undo step,
 * and undoing an unrelated rename should not revert the sort order.
 */
export interface FolderView {
  folderId: string;
  mode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  group: GroupKey;
  /** Icon edge length in px, 32-256. */
  iconSize: number;
  density: Density;
  /** Free-layout only. */
  autoArrange: boolean;
  snapToGrid: boolean;
  /** Details view: which columns are shown, in order. */
  columns: ColumnKey[];
  /**
   * Details view: user-dragged column widths in px. Sparse on purpose — a
   * column the user never touched falls back to `COLUMN_WIDTH`, so changing a
   * default later still reaches everyone who never expressed an opinion. The
   * name column is not listed: it takes whatever is left.
   */
  columnWidths?: Partial<Record<Exclude<ColumnKey, "name">, number>>;
  /**
   * Icon view: fold every day's chats into one stack automatically
   * (「可以选择自动按日折叠」).
   *
   * Derived, never stored as Stack records — the partition is recomputed from
   * `updatedAt` on every read, so a chat that syncs in lands in the right pile
   * without anything having to maintain it. While this is on it **supersedes**
   * hand-made stacks, the same way macOS disables manual arrangement when Use
   * Stacks is on; the hand-made ones stay in the database untouched and come
   * back the moment it goes off.
   */
  autoStack?: AutoStackKey;
}

/** Only "day" for now; the shape leaves room for week/month without migration. */
export type AutoStackKey = "off" | "day";

export type ColumnKey =
  | "name"
  | "updatedAt"
  | "createdAt"
  | "location"
  | "model"
  | "starred";

export const DEFAULT_COLUMNS: ColumnKey[] = ["name", "updatedAt", "model", "location"];

/** Default px width of every fixed column, and the range a drag may reach. */
export const COLUMN_WIDTH: Record<Exclude<ColumnKey, "name">, number> = {
  updatedAt: 150,
  createdAt: 150,
  model: 110,
  location: 190,
  starred: 56
};

/** 「在一定限度」: narrow enough to be useful, never so wide it evicts the name. */
export const COLUMN_WIDTH_RANGE = { min: 48, max: 420 } as const;

export const ICON_SIZE = { min: 32, max: 256, default: 64 } as const;

export function defaultView(folderId: string): FolderView {
  return {
    folderId,
    mode: "icons",
    sortKey: "updatedAt",
    sortAsc: false,
    group: "none",
    iconSize: ICON_SIZE.default,
    // Compact by default per user decision 2026-09-17; comfortable is opt-in.
    density: "compact",
    autoArrange: false,
    snapToGrid: true,
    columns: [...DEFAULT_COLUMNS]
  };
}

/** Spec 5.3: Unfiled opens grouped by month so the filing job is chunked. */
export function unfiledView(): FolderView {
  return { ...defaultView(UNFILED_ID), group: "month" };
}

export function chatUrl(uuid: string): string {
  return `https://claude.ai/chat/${uuid}`;
}

export function chatLabel(chat: Chat): string {
  const name = chat.displayName ?? chat.remoteName;
  return name.trim() || "";
}
