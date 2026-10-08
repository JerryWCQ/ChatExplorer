/**
 * Shell chrome: navigation tree, toolbar, status bar, preview pane. All state
 * lives in App; these render props and raise events.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import type { AuthStatus } from "../claude/api";
import type { SyncProgress } from "../claude/sync";
import { modelInfo } from "../core/model";
import { ROOT_ID, UNFILED_ID, type Chat, type Folder } from "../core/schema";
import { folderPath } from "../core/store";
import { ModelTag } from "../ui/ChatIcon";
import { formatDate, rangeLabel } from "../ui/format";
import { Icon, type IconName } from "../ui/Icon";
import type { Lang, T } from "../ui/i18n";
import { Markdown } from "../ui/markdown";
import {
  folderDisplayName,
  folderPathLabel,
  NAME_COLLATOR,
  type Location,
  type StackInfo,
  type VirtualId
} from "./model";

// --- navigation tree -----------------------------------------------------------

const VIRTUAL_META: { id: VirtualId | "unfiled"; icon: IconName; label: Parameters<T>[0] }[] = [
  { id: "unfiled", icon: "inbox", label: "navUnfiled" },
  { id: "recent", icon: "clock", label: "navRecent" },
  { id: "flagged", icon: "bookmark", label: "navFlagged" },
  { id: "starred", icon: "star", label: "navStarred" },
  { id: "missing", icon: "unlink", label: "navMissing" },
  { id: "hidden", icon: "eyeOff", label: "navHidden" }
];

export interface NavTreeProps {
  folders: Folder[];
  hiddenFolders: Set<string>;
  counts: Record<VirtualId | "unfiled", number>;
  location: Location;
  onNavigate: (loc: Location) => void;
  onFolderContextMenu: (e: ReactMouseEvent, folderId: string) => void;
  onFolderDragOver: (e: DragEvent, folderId: string) => void;
  onFolderDragLeave: (e: DragEvent) => void;
  onFolderDrop: (e: DragEvent, folderId: string) => void;
  /* No `dropFolderId`: the drop highlight is painted onto the DOM by App, so a
     drag never re-renders the tree (or the 1296-cell list beside it). */
  /** Px, owned by App so the resizer and the persisted setting stay in step. */
  width: number;
  t: T;
}

export function NavTree(props: NavTreeProps) {
  const { folders, hiddenFolders, counts, location, onNavigate, t } = props;
  const [open, setOpen] = useState<Set<string>>(() => new Set([ROOT_ID]));

  // Unfiled used to be filtered out of the tree because it already has a row in
  // quick access above. But it is a real folder under the root, and hiding it
  // here made the tree disagree with the content pane, which does list it.
  // It shows in both places now, pinned first among its siblings.
  const childrenOf = (parentId: string) =>
    folders
      .filter((f) => f.parentId === parentId && !f.hidden && !hiddenFolders.has(f.id))
      // Shared collator, not `localeCompare(…, locale)` — see model.ts. The tree
      // re-sorts every branch on every render of the shell.
      .sort((a, b) => {
        const rank = (f: Folder) => (f.id === UNFILED_ID ? 0 : 1);
        return rank(a) - rank(b) || NAME_COLLATOR.compare(a.name, b.name);
      });

  const isCurrentFolder = (id: string) => location.kind === "folder" && location.folderId === id;

  const renderFolder = (folder: Folder, depth: number): ReactNode => {
    const children = childrenOf(folder.id);
    const expanded = open.has(folder.id);
    return (
      <div key={folder.id}>
        <div
          className={`tree-node${isCurrentFolder(folder.id) ? " is-selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onNavigate({ kind: "folder", folderId: folder.id })}
          onContextMenu={(e) => props.onFolderContextMenu(e, folder.id)}
          onDragOver={(e) => props.onFolderDragOver(e, folder.id)}
          onDragLeave={props.onFolderDragLeave}
          onDrop={(e) => props.onFolderDrop(e, folder.id)}
        >
          <span
            className={`tree-twisty${expanded ? " is-open" : ""}`}
            style={{ visibility: children.length > 0 ? "visible" : "hidden" }}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              });
            }}
          >
            <Icon name="chevronRight" size={12} />
          </span>
          {/* The root drops its folder icon so its chevron lands in the same
              column as the quick-access icons above and its label lines up with
              theirs — otherwise the twisty pushed the whole tree 24px right of
              the section above it (「左栏"文件夹"应该最靠左」). Children keep
              their icons, so the nesting is still legible. */}
          {depth > 0 && <Icon name="folder" size={14} />}
          <span className="tree-label">{folderDisplayName(folder, t)}</span>
        </div>
        {expanded && children.map((child) => renderFolder(child, depth + 1))}
      </div>
    );
  };

  const root = folders.find((f) => f.id === ROOT_ID);

  return (
    <nav className="app-nav" style={{ width: props.width }}>
      <div className="nav-section">
        {VIRTUAL_META.map((meta) => {
          const loc: Location =
            meta.id === "unfiled"
              ? { kind: "folder", folderId: UNFILED_ID }
              : { kind: "virtual", id: meta.id };
          const selected =
            meta.id === "unfiled"
              ? isCurrentFolder(UNFILED_ID)
              : location.kind === "virtual" && location.id === meta.id;
          return (
            <div
              key={meta.id}
              className={`tree-node${selected ? " is-selected" : ""}`}
              onClick={() => onNavigate(loc)}
              onDragOver={
                meta.id === "unfiled" ? (e) => props.onFolderDragOver(e, UNFILED_ID) : undefined
              }
              onDragLeave={meta.id === "unfiled" ? props.onFolderDragLeave : undefined}
              onDrop={meta.id === "unfiled" ? (e) => props.onFolderDrop(e, UNFILED_ID) : undefined}
            >
              <Icon name={meta.icon} size={14} />
              <span className="tree-label">{t(meta.label)}</span>
              {counts[meta.id] > 0 && <span className="tree-count">{counts[meta.id]}</span>}
            </div>
          );
        })}
      </div>
      <div className="nav-section">{root && renderFolder(root, 0)}</div>
    </nav>
  );
}

// --- toolbar ------------------------------------------------------------------

export interface ToolbarProps {
  location: Location;
  folders: Folder[];
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigate: (loc: Location) => void;
  searchQuery: string;
  onSearch: (query: string) => void;
  syncing: boolean;
  onSync: () => void;
  onNewFolder: () => void;
  /** False inside the bin — a folder created there would be born deleted. */
  canNewFolder: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  onOpenViewMenu: (anchor: HTMLElement) => void;
  onOpenSortMenu: (anchor: HTMLElement) => void;
  onOpenMoreMenu: (anchor: HTMLElement) => void;
  virtualLabel: (id: VirtualId) => string;
  t: T;
}

export function Toolbar(props: ToolbarProps) {
  const { location, folders, t } = props;
  const searchRef = useRef<HTMLInputElement>(null);

  // A live search overlays the current location rather than replacing it, so the
  // trail keeps showing where you are and appends "search results" as the leaf.
  // That way the crumbs stay clickable to escape the search, and they never
  // disagree with the box's "search in <scope>" placeholder.
  const searching = props.searchQuery.trim().length > 0;

  const crumbs: ReactNode = (() => {
    const sep = (
      <span className="crumb-sep">
        <Icon name="chevronRight" size={12} />
      </span>
    );
    const tail = searching ? (
      <>
        {sep}
        <span className="crumb is-current">{t("searchResults")}</span>
      </>
    ) : null;

    if (location.kind === "folder") {
      const full = folderPath(folders, location.folderId);
      // A folder reached from the bin must not claim to live under the root: the
      // trail is rooted at Deleted and starts at the folder the user actually
      // deleted (the shallowest `hidden` ancestor), because everything above
      // that is still a live, normal folder.
      const cut = full.findIndex((f) => f.hidden);
      const path = cut >= 0 ? full.slice(cut) : full;
      const trashRoot = cut >= 0;
      return (
        <>
          {trashRoot && (
            <button
              className="crumb"
              onClick={() => props.onNavigate({ kind: "virtual", id: "hidden" })}
            >
              {props.virtualLabel("hidden")}
            </button>
          )}
          {path.map((folder, i) => (
            <span key={folder.id} style={{ display: "contents" }}>
              {(i > 0 || trashRoot) && sep}
              <button
                className={`crumb${!searching && i === path.length - 1 ? " is-current" : ""}`}
                onClick={() => props.onNavigate({ kind: "folder", folderId: folder.id })}
              >
                {folderDisplayName(folder, t)}
              </button>
            </span>
          ))}
          {tail}
        </>
      );
    }
    if (location.kind === "virtual") {
      return (
        <>
          <span className={`crumb${searching ? "" : " is-current"}`}>
            {props.virtualLabel(location.id)}
          </span>
          {tail}
        </>
      );
    }
    return <span className="crumb is-current">{t("searchResults")}</span>;
  })();

  const scopeName = (() => {
    if (location.kind === "folder") {
      const folder = folders.find((f) => f.id === location.folderId);
      return folder ? folderDisplayName(folder, t) : t("navRoot");
    }
    if (location.kind === "virtual") return props.virtualLabel(location.id);
    return t("searchResults");
  })();

  return (
    <div className="app-toolbar">
      <button className="btn is-icon" disabled={!props.canBack} onClick={props.onBack} title={t("back")}>
        <Icon name="arrowLeft" size={16} />
      </button>
      <button
        className="btn is-icon"
        disabled={!props.canForward}
        onClick={props.onForward}
        title={t("forward")}
      >
        <Icon name="arrowRight" size={16} />
      </button>
      <button className="btn is-icon" onClick={props.onUp} title={t("up")}>
        <Icon name="arrowUp" size={16} />
      </button>

      <div className="crumbs">{crumbs}</div>

      <div className="search-box">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          placeholder={t("searchIn", { name: scopeName })}
          value={props.searchQuery}
          onChange={(e) => props.onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.onSearch("");
              searchRef.current?.blur();
            }
          }}
        />
        {props.searchQuery && (
          <button className="btn is-icon" style={{ width: 20, height: 20 }} onClick={() => props.onSearch("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <button
        className="btn is-icon"
        onClick={(e) => props.onOpenViewMenu(e.currentTarget)}
        title={t("view")}
      >
        <Icon name="layoutGrid" size={16} />
      </button>
      <button
        className="btn is-icon"
        onClick={(e) => props.onOpenSortMenu(e.currentTarget)}
        title={t("sort")}
      >
        <Icon name="sort" size={16} />
      </button>
      <button
        className="btn is-icon"
        disabled={!props.canNewFolder}
        onClick={props.onNewFolder}
        title={t("newFolder")}
      >
        <Icon name="folderPlus" size={16} />
      </button>
      <button className="btn is-icon" disabled={props.syncing} onClick={props.onSync} title={t("refresh")}>
        <Icon name="refresh" size={16} />
      </button>
      <button
        className={`btn is-icon${props.previewOpen ? " is-active" : ""}`}
        onClick={props.onTogglePreview}
        title={t("previewPane")}
      >
        <Icon name="panelRight" size={16} />
      </button>
      <button
        className="btn is-icon"
        onClick={(e) => props.onOpenMoreMenu(e.currentTarget)}
        title={t("more")}
      >
        <Icon name="moreHorizontal" size={16} />
      </button>
    </div>
  );
}

// --- status bar ------------------------------------------------------------------

export function StatusBar({
  itemCount,
  selectedCount,
  auth,
  syncing,
  syncProgress,
  syncError,
  lastSyncAt,
  lang,
  t
}: {
  itemCount: number;
  selectedCount: number;
  auth: AuthStatus | null;
  syncing: boolean;
  syncProgress: SyncProgress | null;
  syncError: string | null;
  lastSyncAt: number | null;
  lang: Lang;
  t: T;
}) {
  // While a sync runs the status bar reports the phase and a rising count
  // instead of a static "Syncing…": the pull takes about a minute against a
  // full account, and a frozen label is indistinguishable from a hang.
  const runningText = (() => {
    if (!syncProgress) return t("syncRunning");
    if (syncProgress.phase === "auth") return t("syncPhaseAuth");
    if (syncProgress.phase === "write") return t("syncPhaseWrite", { n: syncProgress.fetched });
    return t("syncPhaseList", { n: syncProgress.fetched });
  })();

  const syncText = syncing
    ? runningText
    : syncError
      ? t("syncFailed")
      : lastSyncAt
        ? t("syncIdle", { when: formatDate(new Date(lastSyncAt).toISOString(), lang, t) })
        : t("syncNever");

  return (
    <div className="status-bar">
      <span>{t("itemCount", { n: itemCount })}</span>
      {/* "n left to file" used to sit here. Removed (user decision): the same
          number is already on the Unfiled row in the nav tree, and repeating it
          in a bar that is otherwise about the CURRENT location only invited the
          question of what it was counting. */}
      {selectedCount > 0 && <span>{t("selectedCount", { n: selectedCount })}</span>}
      <span className="spacer" />
      <span title={syncError ?? undefined}>{syncText}</span>
      {auth && (
        <span className={auth.signedIn ? "badge is-ok" : "badge is-bad"}>
          <Icon name={auth.signedIn ? "check" : "alert"} size={12} />
          {auth.signedIn ? t("signedIn") : t("signedOut")}
        </span>
      )}
    </div>
  );
}

// --- pane resizer -------------------------------------------------------------------

export interface PaneResizerProps {
  /** Which pane the handle belongs to; decides the sign of the drag. */
  side: "left" | "right";
  width: number;
  limits: { min: number; max: number; default: number };
  /** Called on every frame of the drag — cheap, local state only. */
  onResize: (width: number) => void;
  /** Called once the width has settled; this is the one that gets persisted. */
  onCommit: (width: number) => void;
  label: string;
}

/**
 * The divider between a side pane and the content. Pointer capture (not a
 * window mouseup listener) ends the drag, for the same reason the marquee uses
 * it: a button released outside the window otherwise leaves the drag live.
 * Double-click restores the default width, and the handle is focusable so the
 * arrow keys can nudge it without a mouse.
 */
export function PaneResizer({ side, width, limits, onResize, onCommit, label }: PaneResizerProps) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  // onCommit must persist the width the drag *ended* on, not the one this
  // handler closed over when the press started.
  const latest = useRef(width);
  latest.current = width;

  const clamp = (w: number) => Math.min(limits.max, Math.max(limits.min, Math.round(w)));
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    onCommit(latest.current);
  };

  return (
    <div
      className={`pane-resizer is-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        drag.current = { x: e.clientX, start: width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if ((e.buttons & 1) === 0) {
          finish();
          return;
        }
        const delta = e.clientX - d.x;
        onResize(clamp(d.start + (side === "left" ? delta : -delta)));
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => {
        onResize(limits.default);
        onCommit(limits.default);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        // App listens for arrows on window to move the selection; a focused
        // divider owns them instead.
        e.preventDefault();
        e.stopPropagation();
        const step = (e.shiftKey ? 32 : 8) * (e.key === "ArrowRight" ? 1 : -1);
        const next = clamp(width + (side === "left" ? step : -step));
        onResize(next);
        onCommit(next);
      }}
    />
  );
}

// --- preview pane -------------------------------------------------------------------

export function PreviewPane({
  chat,
  selectedCount,
  folders,
  shortcutsOf,
  onSaveNotes,
  onOpen,
  onMoveTo,
  width,
  lang,
  t
}: {
  chat: Chat | null;
  selectedCount: number;
  folders: Folder[];
  shortcutsOf: (uuid: string) => string[];
  onSaveNotes: (uuid: string, notes: string) => void;
  onOpen: (chat: Chat) => void;
  onMoveTo: () => void;
  /** Px, owned by App. */
  width: number;
  lang: Lang;
  t: T;
}) {
  const [draft, setDraft] = useState<string>("");
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(chat?.notes ?? "");
  }, [chat?.uuid, chat?.notes]);

  if (!chat) {
    return (
      <aside className="app-preview" style={{ width }}>
        <div className="preview-empty">
          {selectedCount > 1 ? t("selectedChats", { n: selectedCount }) : t("appName")}
        </div>
      </aside>
    );
  }

  const info = modelInfo(chat.model);
  const path = folderPathLabel(folders, chat.folderId, t);
  const shortcutPaths = shortcutsOf(chat.uuid);
  const name = chat.displayName?.trim() || chat.remoteName.trim();

  return (
    <aside className="app-preview" style={{ width }}>
      <h2 className="preview-title">{name || t("untitled", { date: "" })}</h2>
      {chat.displayName && chat.remoteName && chat.displayName.trim() !== chat.remoteName.trim() && (
        <p className="preview-official">{t("officialTitle", { name: chat.remoteName })}</p>
      )}

      <dl className="preview-meta">
        <dt>{t("metaModel")}</dt>
        <dd>
          <ModelTag info={info} />
        </dd>
        <dt>{t("metaCreated")}</dt>
        <dd>{formatDate(chat.createdAt, lang, t)}</dd>
        <dt>{t("metaUpdated")}</dt>
        <dd>{formatDate(chat.updatedAt, lang, t)}</dd>
        <dt>{t("metaLocation")}</dt>
        <dd>{path}</dd>
        {shortcutPaths.length > 0 && (
          <>
            <dt>{t("metaShortcuts")}</dt>
            <dd>{shortcutPaths.join("; ")}</dd>
          </>
        )}
        {chat.projectUuid && (
          <>
            <dt>{t("metaProject")}</dt>
            <dd>{chat.projectUuid.slice(0, 8)}</dd>
          </>
        )}
      </dl>

      {chat.isTemporary && <p className="preview-official">{t("metaTemporary")}</p>}
      {chat.status === "missing" && (
        <p className="preview-official" style={{ color: "var(--danger)" }}>
          {t("metaMissing")}
        </p>
      )}

      {/* The summary is Markdown. The thumbnail flattens it because it has no
          room; here there is room, so the structure the summary was written
          with is shown as structure. */}
      {chat.summary.trim() ? (
        <Markdown className="preview-summary" text={chat.summary} />
      ) : (
        <p className="preview-summary">{t("noSummary")}</p>
      )}

      <textarea
        className="preview-notes"
        value={draft}
        placeholder="…"
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          editing.current = false;
          if (draft !== chat.notes) onSaveNotes(chat.uuid, draft);
        }}
      />

      <div className="preview-actions">
        <button className="btn is-primary" onClick={() => onOpen(chat)}>
          <Icon name="externalLink" size={14} />
          {t("openOnClaude")}
        </button>
        <button className="btn" onClick={onMoveTo}>
          <Icon name="folder" size={14} />
          {t("moveTo")}
        </button>
      </div>
    </aside>
  );
}

/**
 * The preview for a selected pile.
 *
 * A pile carries its newest member's chat so sorting and grouping work, but
 * showing that one chat's summary here would describe a single card, not the
 * pile the user clicked (user decision). So the pane describes the pile
 * itself: what it spans, where it lives, which models are in it, and what is
 * inside — each member a link that opens the pile and selects it.
 */
export function StackPreview({
  name,
  stack,
  open,
  folders,
  onToggle,
  onDissolve,
  onReveal,
  width,
  lang,
  t
}: {
  name: string;
  stack: StackInfo;
  open: boolean;
  folders: Folder[];
  onToggle: () => void;
  /** Null for an auto-stack: it is a property of the view and cannot be dissolved. */
  onDissolve: (() => void) | null;
  onReveal: (memberKey: string) => void;
  width: number;
  lang: Lang;
  t: T;
}) {
  const n = stack.members.length;
  const models = useMemo(() => {
    const byLabel = new Map<string, { info: ReturnType<typeof modelInfo>; n: number }>();
    for (const m of stack.members) {
      const info = modelInfo(m.chat?.model);
      const hit = byLabel.get(info.label);
      if (hit) hit.n++;
      else byLabel.set(info.label, { info, n: 1 });
    }
    return [...byLabel.values()].sort((a, b) => b.n - a.n);
  }, [stack.members]);

  return (
    <aside className="app-preview" style={{ width }}>
      <h2 className="preview-title">{name}</h2>
      <p className="preview-official">
        {t(stack.record ? "stackPreviewKind" : "stackPreviewAuto", { n })}
      </p>

      <dl className="preview-meta">
        <dt>{t("metaRange")}</dt>
        <dd>{rangeLabel(stack.updatedFrom, stack.updatedTo, lang, t)}</dd>
        <dt>{t("metaLocation")}</dt>
        <dd>{folderPathLabel(folders, stack.folderId, t)}</dd>
        <dt>{t("metaModel")}</dt>
        <dd className="stack-models">
          {models.map(({ info, n: count }) => (
            <span key={info.label} className="stack-model">
              <ModelTag info={info} />
              <span className="stack-model-count">{count}</span>
            </span>
          ))}
        </dd>
      </dl>

      <ol className="stack-members">
        {stack.members.map((m) => (
          <li key={m.key}>
            <button type="button" className="stack-member" onClick={() => onReveal(m.key)}>
              <span className="stack-member-name">{m.name}</span>
              {m.chat && (
                <span className="stack-member-date">{formatDate(m.chat.updatedAt, lang, t)}</span>
              )}
            </button>
          </li>
        ))}
      </ol>

      <div className="preview-actions">
        <button className="btn is-primary" onClick={onToggle}>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
          {open ? t("stackCollapse") : t("stackExpand")}
        </button>
        {onDissolve && (
          <button className="btn" onClick={onDissolve}>
            <Icon name="layersOff" size={14} />
            {t("stackDissolve")}
          </button>
        )}
      </div>
    </aside>
  );
}
