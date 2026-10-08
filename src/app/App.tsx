/**
 * The application shell. Owns every piece of interactive state — navigation
 * history, selection, clipboard, editing, overlays — and hands the views pure
 * props. All writes go through the data port.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  defaultView,
  ROOT_ID,
  STACK_MIN_MEMBERS,
  UNFILED_ID,
  type Chat,
  type FolderView
} from "../core/schema";
import { PANE_LIMITS } from "../core/settings";
import { folderPath, isSystemFolder, type ItemRef } from "../core/store";
import { resolveView } from "../core/views";
import { Icon } from "../ui/Icon";
import { resolveLang, translator, type T } from "../ui/i18n";
import type { AgentScope } from "../agent/types";
import { AgentPanel, type AgentRequest } from "./agent-panel";
import { NavTree, PaneResizer, PreviewPane, StackPreview, StatusBar, Toolbar } from "./chrome";
import { port } from "./dataport";
import {
  countsFor,
  foldStacks,
  folderDisplayName,
  folderPathLabel,
  groupItems,
  isAutoStack,
  itemKey,
  listItems,
  locationKey,
  makeListContext,
  naturalAsc,
  normalizeForSearch,
  refsToChatUuids,
  sortItems,
  stackableKeys,
  stacksOf,
  type Item,
  type Location,
  type VirtualId
} from "./model";
import {
  ConfirmDialog,
  ContextMenu,
  HistoryPanel,
  Picker,
  SettingsPanel,
  ToastHost,
  type ConfirmSpec,
  type MenuEntry,
  type MenuSpec,
  type PickerOption,
  type ToastSpec
} from "./overlays";
import { openChatTab } from "./openChat";
import { useAppData } from "./useAppData";
import { ViewScrollbar } from "./scrollbar";
import { paintSelection, useMarquee } from "./useMarquee";
import { DetailsView, IconView, type ItemHandlers } from "./views";

const HOME: Location = { kind: "folder", folderId: ROOT_ID };
const NO_PEEK: (string | null)[] = [];

let toastSeq = 0;

function clampPane(width: number, limits: { min: number; max: number; default: number }): number {
  if (!Number.isFinite(width)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.round(width)));
}

/**
 * How many columns the icon grid currently has. `auto-fill` decides that from
 * the pane width, so it cannot be derived from the data — the computed
 * `grid-template-columns` is a resolved track list ("184px 184px ...") and its
 * length is the only reliable source. Falls back to 1, which degrades keyboard
 * navigation to the old linear behaviour rather than breaking it.
 */
function gridColumns(scroll: HTMLElement | null, key: string): number {
  const cell = scroll?.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const grid = cell?.closest(".icon-grid");
  if (!grid) return 1;
  const tracks = getComputedStyle(grid).gridTemplateColumns.trim();
  if (!tracks || tracks === "none") return 1;
  return Math.max(1, tracks.split(/\s+/).length);
}

export function App() {
  const app = useAppData();
  const { data, settings } = app;

  const lang = resolveLang(settings?.language ?? "auto");
  const t: T = useMemo(() => translator(lang), [lang]);

  // --- theme ------------------------------------------------------------------
  useEffect(() => {
    const apply = () => {
      const pref = settings?.theme ?? "system";
      const dark =
        pref === "dark" ||
        (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings?.theme]);

  // --- navigation --------------------------------------------------------------
  const [hist, setHist] = useState<{ stack: Location[]; index: number }>({
    stack: [HOME],
    index: 0
  });
  const location = hist.stack[hist.index] ?? HOME;
  const [searchQuery, setSearchQuery] = useState("");

  const navigate = useCallback((loc: Location) => {
    setSearchQuery("");
    setHist((h) => {
      const current = h.stack[h.index];
      if (current && locationKey(current) === locationKey(loc)) return h;
      const stack = [...h.stack.slice(0, h.index + 1), loc];
      return { stack, index: stack.length - 1 };
    });
  }, []);

  const goBack = () => setHist((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const goForward = () =>
    setHist((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));
  const goUp = () => {
    if (searchQuery) {
      setSearchQuery("");
      return;
    }
    if (location.kind === "folder" && location.folderId !== ROOT_ID) {
      const folder = data?.folders.find((f) => f.id === location.folderId);
      navigate({ kind: "folder", folderId: folder?.parentId ?? ROOT_ID });
    } else if (location.kind !== "folder") {
      navigate(HOME);
    }
  };

  // Search overlays the current location without touching history.
  const effLoc: Location = useMemo(() => {
    if (searchQuery.trim()) {
      const scope = location.kind === "folder" ? location.folderId : ROOT_ID;
      return { kind: "search", query: searchQuery, scopeFolderId: scope };
    }
    return location;
  }, [location, searchQuery]);

  const locKey = locationKey(effLoc);

  // --- list building ------------------------------------------------------------
  const ctx = useMemo(
    () =>
      data && settings ? makeListContext(data, lang, t, settings.recentCount) : null,
    [data, settings, lang, t]
  );

  const [virtualViews, setVirtualViews] = useState<Record<string, FolderView>>({});

  const view: FolderView = useMemo(() => {
    if (!data || !settings) return defaultView(ROOT_ID);
    if (effLoc.kind === "folder") return resolveView(app.views, data.folders, effLoc.folderId);
    const stored = virtualViews[locationKey(effLoc)];
    if (stored) return stored;
    return {
      ...defaultView(`virtual:${locationKey(effLoc)}`),
      mode: "details",
      density: settings.defaultDensity
    };
  }, [data, settings, effLoc, app.views, virtualViews]);

  const updateView = useCallback(
    (patch: Partial<FolderView>) => {
      if (effLoc.kind === "folder") {
        void port.saveView({ ...view, ...patch, folderId: effLoc.folderId });
      } else {
        setVirtualViews((prev) => ({ ...prev, [locationKey(effLoc)]: { ...view, ...patch } }));
      }
    },
    [effLoc, view]
  );

  /**
   * Which piles are fanned open.
   *
   * Session-only and keyed by location, for the same reasons collapsed groups
   * are: opening a pile is a way of looking at a folder, not a property of it.
   * There is a second reason here though — an auto-stack's id exists only for
   * as long as this list does, so persisting it would slowly fill the database
   * with keys for piles that can never come back.
   */
  const [openStackKeys, setOpenStackKeys] = useState<Set<string>>(new Set());
  const openStacks = useMemo(() => {
    const prefix = `${locKey}\u0000`;
    const out = new Set<string>();
    for (const key of openStackKeys) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
    }
    return out;
  }, [openStackKeys, locKey]);

  const onStackToggle = useCallback(
    (item: Item) => {
      const key = `${locKey}\u0000${item.ref.id}`;
      setOpenStackKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [locKey]
  );

  const { groups, allItems } = useMemo(() => {
    if (!ctx || !data) return { groups: [], allItems: [] as Item[] };
    // Fold between sorting and grouping: a pile takes the slot of its first
    // member, so it lands wherever the sort put that member, and grouping then
    // treats it as the one item it now is. See `foldStacks`.
    const items = sortItems(listItems(ctx, effLoc), view, data.folders, t);
    const folded = foldStacks(items, ctx, effLoc, view, openStacks);
    const grouped = groupItems(folded, view.group, data.folders, lang, t);
    return { groups: grouped, allItems: grouped.flatMap((g) => g.items) };
  }, [ctx, data, effLoc, view, lang, t, openStacks]);

  // Stacks exist only in the list that produced them — an auto-stack has no
  // record anywhere. So anything that has to turn a selection into real chats
  // (`refsToChatUuids`) needs this map to expand a pile ref into its members.
  const stackById = useMemo(() => stacksOf(allItems), [allItems]);

  // --- collapsed groups ------------------------------------------------------------
  // Keyed by location so collapsing "September" in one folder does not collapse
  // it everywhere. Session-only: a collapsed group is a reading posture, not a
  // property of the folder, so it is not worth a write to IndexedDB.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const collapsed = useMemo(() => {
    const out = new Set<string>();
    for (const g of groups) if (collapsedKeys.has(`${locKey}\u0000${g.id}`)) out.add(g.id);
    return out;
  }, [groups, collapsedKeys, locKey]);

  const onToggleGroup = useCallback(
    (id: string) => {
      setCollapsedKeys((prev) => {
        const next = new Set(prev);
        const key = `${locKey}\u0000${id}`;
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [locKey]
  );

  /**
   * Collapse or expand every group *in this location*. Deliberately not a global
   * wipe: the keys are per-location, and a user who collapses everything here
   * has said nothing about the folder they visit next.
   */
  const setAllCollapsed = useCallback(
    (want: boolean) => {
      setCollapsedKeys((prev) => {
        const next = new Set(prev);
        for (const g of groups) {
          const key = `${locKey}\u0000${g.id}`;
          if (want) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [groups, locKey]
  );

  /**
   * Items a collapsed group hides are gone from the keyboard index and from
   * marquee hit-testing (they have no DOM node), so every index-based path has
   * to walk this list rather than `allItems`.
   */
  const flat = useMemo(
    () =>
      collapsed.size === 0
        ? allItems
        : groups.flatMap((g) => (collapsed.has(g.id) ? [] : g.items)),
    [groups, allItems, collapsed]
  );

  // Lookups stay over ALL items: a chat inside a collapsed group is still
  // selected, still previewable, still a valid paste/undo target.
  const itemByKey = useMemo(() => new Map(allItems.map((i) => [i.key, i])), [allItems]);

  const peekFor = useMemo(() => {
    const byFolder = new Map<string, (string | null)[]>();
    if (data) {
      // Plain string comparison, not localeCompare: these are ISO 8601, so text
      // order is chronological order, and localeCompare builds a collator on
      // every call — a thousand-odd chats is ~13 000 of them for nothing.
      const sorted = [...data.chats]
        .filter((c) => !c.hidden)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      for (const c of sorted) {
        const list = byFolder.get(c.folderId) ?? [];
        if (list.length < 3) {
          list.push(c.model);
          byFolder.set(c.folderId, list);
        }
      }
    }
    // A shared empty array, not a fresh literal: the grid cells are memoised
    // and a new [] every call would invalidate every childless folder.
    return (folderId: string) => byFolder.get(folderId) ?? NO_PEEK;
  }, [data]);

  // --- selection -----------------------------------------------------------------
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const anchorIndex = useRef<number | null>(null);
  const pendingCollapse = useRef<string | null>(null);
  const dragOccurred = useRef(false);

  // Prune selection when items vanish (delete, sync, navigation).
  useEffect(() => {
    setSelection((prev) => {
      const next = new Set([...prev].filter((k) => itemByKey.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [itemByKey]);

  /**
   * "Take me to that item and show me where it lives." Set by `revealChat`
   * just before it navigates, consumed by the effect below.
   *
   * It has to be a ref rather than state: navigating clears the selection, and
   * a `setSelection` issued alongside `navigate` would be wiped by that very
   * cleanup a moment later. (The quick-jump picker had exactly this bug — it
   * selected the chat it jumped to, and the selection silently vanished.)
   */
  const revealRef = useRef<string | null>(null);
  /** The shared scroll container — the marquee's coordinate system, and the
      thing `revealChat` has to scroll. Declared here because both need it. */
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Navigation clears selection and editing — unless we arrived here *looking*
    // for something, in which case that thing is the selection.
    const reveal = revealRef.current;
    revealRef.current = null;
    setSelection(reveal ? new Set([reveal]) : new Set());
    setFocusKey(reveal);
    setEditingKey(null);
    anchorIndex.current = null;
    if (!reveal) return;
    // One frame later the new list has been committed and the row exists.
    const raf = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-key="${CSS.escape(reveal)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [locKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Go to where a chat actually lives, select it, and scroll it into view.
   *
   * This is what a shortcut's 「定位到原文件」 does, and it is the only honest
   * answer to "where is this really?" — a shortcut is an alias, so following it
   * has to land on the one true copy. The same entry serves any chat reached
   * from a virtual view or a search result, where the folder is off-screen.
   */
  const revealChat = useCallback(
    (chat: Chat) => {
      const key = `chat:${chat.uuid}`;
      const target: Location = { kind: "folder", folderId: chat.folderId };
      // Navigating to where you already are is a no-op, so the effect below
      // would never fire and the pending reveal would leak into the next move.
      if (locationKey(location) === locationKey(target) && !searchQuery) {
        setSelection(new Set([key]));
        setFocusKey(key);
        scrollRef.current
          ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "center" });
        return;
      }
      revealRef.current = key;
      navigate(target);
    },
    [location, navigate, searchQuery]
  );

  const selectRange = (from: number, to: number, additive: boolean) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    setSelection((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (let i = a; i <= b; i++) {
        const item = flat[i];
        if (item) next.add(item.key);
      }
      return next;
    });
  };

  // --- clipboard -------------------------------------------------------------------
  const [clipboard, setClipboard] = useState<{ mode: "cut" | "copy"; refs: ItemRef[] } | null>(
    null
  );
  const cutKeys = useMemo(
    () =>
      clipboard?.mode === "cut" ? new Set(clipboard.refs.map(itemKey)) : new Set<string>(),
    [clipboard]
  );

  /**
   * Replace every pile in `refs` with the things inside it.
   *
   * A stack ref addresses a fold, not a filed object, so no action — move,
   * delete, flag, cut, drag — can do anything with one. Expanding here means
   * every one of those keeps working on plain chats and never learns that
   * stacks exist, which matches what dragging a stack does on macOS: you are
   * dragging the files, not the pile.
   */
  const expandRefs = useCallback(
    (refs: ItemRef[]): ItemRef[] => {
      if (!refs.some((r) => r.kind === "stack")) return refs;
      const seen = new Set<string>();
      const out: ItemRef[] = [];
      const push = (ref: ItemRef) => {
        const key = itemKey(ref);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(ref);
      };
      for (const ref of refs) {
        if (ref.kind !== "stack") {
          push(ref);
          continue;
        }
        const info = stackById.get(ref.id);
        if (info) for (const m of info.members) push(m.ref);
      }
      return out;
    },
    [stackById]
  );

  const selectedRefs = useCallback((): ItemRef[] => {
    const refs: ItemRef[] = [];
    for (const key of selection) {
      const item = itemByKey.get(key);
      if (item) refs.push(item.ref);
    }
    return expandRefs(refs);
  }, [selection, itemByKey, expandRefs]);

  // --- overlays -----------------------------------------------------------------------
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [menu, setMenu] = useState<MenuSpec | null>(null);
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const [picker, setPicker] = useState<"jump" | "move" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The AI organizer panel; null = closed. It takes the preview pane's slot. */
  const [agent, setAgent] = useState<AgentRequest | null>(null);
  const agentBusy = useRef(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean | null>(null);

  useEffect(() => {
    if (previewOpen === null && settings) setPreviewOpen(settings.previewPaneDefault);
  }, [settings, previewOpen]);

  // --- pane widths --------------------------------------------------------------
  // Held in local state during a drag so a frame costs one re-render instead of
  // an IndexedDB write; the settled width is persisted on release.
  const [paneWidths, setPaneWidths] = useState<{ nav: number; preview: number; agent: number } | null>(null);
  useEffect(() => {
    if (paneWidths === null && settings) {
      setPaneWidths({
        nav: clampPane(settings.navWidth, PANE_LIMITS.nav),
        preview: clampPane(settings.previewWidth, PANE_LIMITS.preview),
        agent: clampPane(settings.agentWidth, PANE_LIMITS.agent)
      });
    }
  }, [settings, paneWidths]);
  const navWidth = paneWidths?.nav ?? PANE_LIMITS.nav.default;
  const previewWidth = paneWidths?.preview ?? PANE_LIMITS.preview.default;
  const agentWidth = paneWidths?.agent ?? PANE_LIMITS.agent.default;

  const pushToast = useCallback((message: string, undoable = true) => {
    const id = ++toastSeq;
    setToasts((prev) => [
      ...prev.slice(-2),
      undoable
        ? { id, message, actionLabel: t("undo"), onAction: () => void port.undo() }
        : { id, message }
    ]);
  }, [t]);

  /**
   * Open the AI organizer on a scope. A running conversation is not thrown away
   * by a stray right-click: the user is told to stop it first.
   */
  const openAgent = useCallback(
    (scope: AgentScope) => {
      if (agentBusy.current) {
        pushToast(t("aiBusy"), false);
        return;
      }
      setAgent({ scope, sessionId: null, nonce: Date.now() });
    },
    [pushToast, t]
  );

  /**
   * Brief highlight on what an AI batch just changed, so the user can follow
   * the work in the grid. Painted straight onto the DOM like the drag and
   * selection states — a batch can touch hundreds of cells, and this must not
   * cost a render of any of them.
   */
  const flashKeys = useCallback((keys: string[]) => {
    const hit: Element[] = [];
    for (const key of keys) {
      for (const el of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) {
        el.classList.remove("is-agent-touched");
        // Restart the animation if the same cell is hit twice in a row.
        void (el as HTMLElement).offsetWidth;
        el.classList.add("is-agent-touched");
        hit.push(el);
      }
    }
    if (hit.length) window.setTimeout(() => hit.forEach((el) => el.classList.remove("is-agent-touched")), 1800);
  }, []);

  // A batch's changes reach the grid only after the data reload that its
  // commit triggers, so the highlight waits for that render (below). The timer
  // is the fallback for a batch that changed nothing this view shows.
  const pendingFlash = useRef<string[] | null>(null);
  const onAgentCommitted = useCallback(
    (keys: string[]) => {
      pendingFlash.current = keys;
      window.setTimeout(() => {
        if (pendingFlash.current !== keys) return;
        pendingFlash.current = null;
        flashKeys(keys);
      }, 600);
    },
    [flashKeys]
  );
  useLayoutEffect(() => {
    const keys = pendingFlash.current;
    if (!keys) return;
    pendingFlash.current = null;
    flashKeys(keys);
  }, [data, flashKeys]);

  /**
   * A failed sync used to show only the word "failed" in the status bar, with
   * the reason buried in a `title` tooltip nobody hovers. Since the reason is
   * the whole diagnosis — which of the two transports was refused, and at
   * which step — it gets a toast of its own.
   */
  const reportedSyncError = useRef<string | null>(null);
  useEffect(() => {
    if (!app.syncError || app.syncError === reportedSyncError.current) return;
    reportedSyncError.current = app.syncError;
    pushToast(t("toastSyncFailed", { reason: app.syncError }), false);
  }, [app.syncError, pushToast, t]);

  /**
   * What a finished sync says, and to whom.
   *
   * The count-and-duration line is **debug only**. It existed to prove the
   * three-minute sync was fixed; now that it is, a toast after every scheduled
   * sync is just a thing to dismiss, and the status bar already carries "synced
   * · 2 minutes ago" permanently.
   *
   * The tab-transport line is not gated. That path is a fallback (see
   * `claude/api.ts`) and the whole point of announcing it is to hear about it
   * while everything still works, not on the day it stops — which is precisely
   * when nobody has debug turned on.
   */
  const debug = settings?.debug ?? false;
  const reportedSyncDone = useRef<unknown>(null);
  useEffect(() => {
    const done = app.syncDone;
    if (!done || done === reportedSyncDone.current) return;
    reportedSyncDone.current = done;
    if (debug) {
      pushToast(
        t("toastSyncDone", {
          n: done.total,
          sec: Math.max(1, Math.round(done.ms / 1000)),
          added: done.added,
          missing: done.missing
        }),
        false
      );
    }
    if (done.transport === "tab") pushToast(t("toastSyncViaTab"), false);
  }, [app.syncDone, debug, pushToast, t]);

  const expireToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // --- actions -------------------------------------------------------------------------
  /**
   * A successful in-page switch says nothing unless debug is on: it is the
   * outcome the user asked for, it already happened in a tab they can see, and
   * announcing a success with a millisecond count on every open is noise.
   *
   * The reload is a different animal and stays unconditional — it is the fast
   * path quietly giving up, and the tab the user was reading got replaced. That
   * must never be silent.
   */
  const openChat = useCallback(
    async (chat: Chat) => {
      const outcome = await openChatTab(chat.uuid, settings?.openMode ?? "newTab");
      if (outcome.kind === "inPage") {
        if (debug) pushToast(t("toastOpenedInPage", { ms: outcome.ms }), false);
      } else if (outcome.kind === "reloaded") pushToast(t("toastOpenedReload"), false);
    },
    [settings?.openMode, debug, pushToast, t]
  );

  const startRename = useCallback(() => {
    const key = focusKey ?? [...selection][0];
    if (key) setEditingKey(key);
  }, [focusKey, selection]);

  const doDelete = useCallback(
    (refs: ItemRef[]) => {
      if (!data || refs.length === 0) return;
      const shortcutIds = refs.filter((r) => r.kind === "shortcut").map((r) => r.id);
      const folderIds = refs
        .filter((r) => r.kind === "folder")
        .map((r) => r.id)
        .filter((id) => !isSystemFolder(id));
      const chatUuids = refs.filter((r) => r.kind === "chat").map((r) => r.id);

      // Shortcuts are just aliases: no dialog, undoable, toast instead.
      if (shortcutIds.length > 0 && folderIds.length === 0 && chatUuids.length === 0) {
        void port.deleteShortcuts(shortcutIds).then(() => {
          pushToast(t("toastDeleted", { n: shortcutIds.length }));
        });
        return;
      }

      const total = folderIds.length + chatUuids.length + shortcutIds.length;
      const singleFolder =
        folderIds.length === 1 && chatUuids.length === 0 && shortcutIds.length === 0
          ? data.folders.find((f) => f.id === folderIds[0])
          : undefined;

      setConfirm({
        title: singleFolder
          ? t("confirmDeleteFolderTitle", { name: singleFolder.name })
          : t("confirmDeleteChatsTitle", { n: total }),
        body: singleFolder ? t("confirmDeleteFolderBody") : t("confirmDeleteChatsBody"),
        confirmLabel: t("confirm"),
        danger: true,
        onConfirm: async () => {
          if (shortcutIds.length > 0) await port.deleteShortcuts(shortcutIds);
          for (const id of folderIds) await port.setFolderHidden(id, true);
          if (chatUuids.length > 0) await port.setChatsHidden(chatUuids, true);
          pushToast(t("toastDeleted", { n: total }));
        }
      });
    },
    [data, pushToast, t]
  );

  const doRestore = useCallback(
    async (refs: ItemRef[]) => {
      if (refs.length === 0) return;
      // One call, one undo step — and it un-hides the folders above the item
      // too, which is what makes a restore from deep inside the bin visible.
      await port.restoreRefs(refs);
      pushToast(t("toastRestored", { n: refs.length }));
    },
    [pushToast, t]
  );

  /**
   * The terminal delete. Cascades through folders, and — unlike the soft delete
   * — says out loud that a chat still living on claude.ai will be pulled back in
   * by the next sync. Pretending otherwise would be the more surprising bug.
   */
  const doPurge = useCallback(
    (refs: ItemRef[]) => {
      if (!data || refs.length === 0) return;
      const first = refs[0];
      const onlyFolder =
        refs.length === 1 && first?.kind === "folder"
          ? data.folders.find((f) => f.id === first.id)
          : undefined;
      setConfirm({
        title: onlyFolder
          ? t("confirmPurgeTitle", { name: folderDisplayName(onlyFolder, t) })
          : t("confirmPurgeManyTitle", { n: refs.length }),
        body: refs.some((r) => r.kind === "folder")
          ? t("confirmPurgeFolderBody")
          : t("confirmPurgeBody"),
        confirmLabel: t("purge"),
        danger: true,
        onConfirm: async () => {
          await port.purgeRefs(refs);
          pushToast(t("toastPurged", { n: refs.length }));
        }
      });
    },
    [data, pushToast, t]
  );

  const doPaste = useCallback(async () => {
    if (!clipboard || !data || effLoc.kind !== "folder") return;
    const target = effLoc.folderId;
    if (clipboard.mode === "copy") {
      const uuids = refsToChatUuids(clipboard.refs, data);
      const ids = await port.createShortcuts(uuids, target);
      if (ids.length > 0) pushToast(t("toastShortcut", { n: ids.length }));
    } else {
      const chatUuids = clipboard.refs.filter((r) => r.kind === "chat").map((r) => r.id);
      const shortcutIds = clipboard.refs.filter((r) => r.kind === "shortcut").map((r) => r.id);
      const folderIds = clipboard.refs.filter((r) => r.kind === "folder").map((r) => r.id);
      if (chatUuids.length > 0) await port.moveChats(chatUuids, target);
      if (shortcutIds.length > 0) await port.moveShortcuts(shortcutIds, target);
      for (const id of folderIds) {
        try {
          await port.moveFolder(id, target);
        } catch {
          // cycle or system folder; skip silently, the rest still lands
        }
      }
      pushToast(t("toastMoved", { n: clipboard.refs.length }));
      setClipboard(null);
    }
  }, [clipboard, data, effLoc, pushToast, t]);

  const moveRefsTo = useCallback(
    async (refs: ItemRef[], folderId: string, asShortcut: boolean) => {
      if (!data) return;
      if (asShortcut) {
        const uuids = refsToChatUuids(refs, data);
        const ids = await port.createShortcuts(uuids, folderId);
        if (ids.length > 0) pushToast(t("toastShortcut", { n: ids.length }));
        return;
      }
      const chatUuids = refs.filter((r) => r.kind === "chat").map((r) => r.id);
      const shortcutIds = refs.filter((r) => r.kind === "shortcut").map((r) => r.id);
      const folderIds = refs.filter((r) => r.kind === "folder").map((r) => r.id);
      if (chatUuids.length > 0) await port.moveChats(chatUuids, folderId);
      if (shortcutIds.length > 0) await port.moveShortcuts(shortcutIds, folderId);
      for (const id of folderIds) {
        try {
          await port.moveFolder(id, folderId);
        } catch {
          /* cycle/system, skip */
        }
      }
      pushToast(t("toastMoved", { n: refs.length }));
    },
    [data, pushToast, t]
  );

  // --- stacks ---------------------------------------------------------------------

  /**
   * Fold a selection into one pile.
   *
   * The pile is born open-less: it collapses immediately, which is the whole
   * point of the gesture. It also inherits the selection, so the next Del or
   * drag acts on the same chats it did a moment ago.
   */
  const doStack = useCallback(
    async (items: Item[]) => {
      if (effLoc.kind !== "folder") return;
      const members = stackableKeys(items);
      if (members.length < STACK_MIN_MEMBERS) {
        pushToast(t("toastStackTooFew", { n: STACK_MIN_MEMBERS }));
        return;
      }
      const id = await port.createStack(effLoc.folderId, members);
      if (!id) return;
      setSelection(new Set([`stack:${id}`]));
      pushToast(t("toastStacked", { n: members.length }));
    },
    [effLoc, pushToast, t]
  );

  const doTakeOut = useCallback(
    async (stackId: string, items: Item[]) => {
      const members = stackableKeys(items);
      if (members.length === 0) return;
      await port.removeFromStack(stackId, members);
    },
    []
  );

  /**
   * Dropping onto a pile.
   *
   * The refs are already expanded to real chats and, because a drag can only
   * start from a cell in this same grid, they already live in this folder — so
   * this is purely a membership change, not a move.
   */
  const doAddToStack = useCallback(
    async (stackId: string, refs: ItemRef[]) => {
      const members = refs.filter((r) => r.kind !== "folder" && r.kind !== "stack").map(itemKey);
      if (members.length === 0) return;
      await port.addToStack(stackId, members);
      pushToast(t("toastStackAdded", { n: members.length }));
    },
    [pushToast, t]
  );

  const newFolder = useCallback(async () => {
    // A folder born inside the bin would be born deleted. Refuse rather than
    // silently create it at the root, which would look like the click missed.
    if (ctx && effLoc.kind === "folder" && ctx.hiddenFolders.has(effLoc.folderId)) return;
    const parent = effLoc.kind === "folder" ? effLoc.folderId : ROOT_ID;
    const id = await port.createFolder(parent, t("newFolder"));
    setSelection(new Set([`folder:${id}`]));
    setEditingKey(`folder:${id}`);
  }, [ctx, effLoc, t]);

  /**
   * Export asks first, and the question carries the two facts you need to
   * answer it: how much is in the file, and what the file will be called. A
   * download that starts with no warning and lands under an invented name is
   * indistinguishable from a bug.
   */
  const exportBackup = useCallback(() => {
    if (!data) return;
    const total = data.folders.length + data.chats.length + data.shortcuts.length;
    const file = `chatexplorer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    setConfirm({
      title: t("confirmExportTitle", { n: total }),
      body: t("confirmExportBody", { file }),
      confirmLabel: t("exportConfirm"),
      onConfirm: () => {
        const payload = {
          exportedAt: new Date().toISOString(),
          folders: data.folders,
          chats: data.chats,
          shortcuts: data.shortcuts,
          // Not counted in `total` above: a stack is a fold over items, not an
          // item, so counting it would inflate the number the dialog promises.
          stacks: data.stacks
        };
        const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file;
        a.click();
        URL.revokeObjectURL(url);
      }
    });
  }, [data, t]);

  // --- drag & drop ----------------------------------------------------------------------
  //
  // 〔修订 2026-09-19 第二批〕**A native drag touches React zero times.**
  //
  // The previous round removed the per-frame `setState` from `dragover`, and the
  // freeze survived unchanged (user: 「拖拽卡死仍然完全没有解决」). What was left
  // was still enough to be suspect: `dragstart` pushed `draggingKeys` (and often
  // a selection) through App, i.e. a full 1296-element reconcile *inside the
  // event handler the browser is waiting on to begin the drag*; and every change
  // of drop target pushed another.
  //
  // So the two purely decorative bits of drag state — which cells are being
  // dragged (`is-dragging`) and which folder is the current drop target
  // (`is-drop`) — are no longer React state at all. They are written straight to
  // `classList`, exactly like the marquee's selection paint. React never learns
  // a drag is happening; the only thing it ever sees is the finished move.
  const dragRefs = useRef<ItemRef[]>([]);
  /** What the DOM should currently be painted with. Not state: never rendered. */
  const dragPaint = useRef<{ keys: Set<string>; drop: HTMLElement | null }>({
    keys: new Set(),
    drop: null
  });

  /**
   * Bring the DOM in line with `dragPaint`. Reading the class first means an
   * unchanged node costs nothing — no attribute write, so no style recalc.
   */
  const applyDragPaint = useCallback(() => {
    const { keys, drop } = dragPaint.current;
    for (const node of document.querySelectorAll<HTMLElement>("[data-key]")) {
      const on = keys.has(node.dataset.key!);
      if (node.classList.contains("is-dragging") !== on) {
        node.classList.toggle("is-dragging", on);
      }
    }
    // Normally 0 or 1 nodes; the sweep exists so a target that vanished mid-drag
    // (folder scrolled out and recycled, view switched) cannot stay lit.
    for (const node of document.querySelectorAll<HTMLElement>(".is-drop")) {
      if (node !== drop) node.classList.remove("is-drop");
    }
    if (drop) drop.classList.add("is-drop");
  }, []);

  /**
   * React owns `className` on every cell, so any render that lands during a live
   * drag overwrites the classes painted above. Re-applying after each commit is
   * what makes the paint self-healing. With no drag live this is one `Set.size`
   * test per render.
   */
  useEffect(() => {
    if (dragPaint.current.keys.size > 0 || dragPaint.current.drop) applyDragPaint();
  });

  /** Cheap enough to call from `dragover`, which repeats at screen rate. */
  const setDropNode = useCallback((node: HTMLElement | null) => {
    const cur = dragPaint.current.drop;
    if (cur === node) return;
    cur?.classList.remove("is-drop");
    dragPaint.current.drop = node;
    node?.classList.add("is-drop");
  }, []);

  const onDragStart = useCallback(
    (e: DragEvent, item: Item) => {
      dragOccurred.current = true;
      let refs: ItemRef[];
      if (selection.has(item.key)) {
        refs = selectedRefs();
      } else {
        refs = [item.ref];
        setSelection(new Set([item.key]));
      }
      dragRefs.current = refs;
      dragPaint.current = { keys: new Set(refs.map(itemKey)), drop: null };
      applyDragPaint();
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("application/x-chatexplorer", JSON.stringify(refs));
    },
    [selection, selectedRefs, applyDragPaint]
  );

  const endDrag = useCallback(() => {
    dragRefs.current = [];
    if (dragPaint.current.keys.size === 0 && !dragPaint.current.drop) return;
    dragPaint.current = { keys: new Set(), drop: null };
    applyDragPaint();
  }, [applyDragPaint]);

  const onFolderDragOver = useCallback(
    (e: DragEvent, folderId: string) => {
      // Foreign drags — a selected run of text, a file from the desktop, an image
      // from another tab — must fall straight through, or we light up a drop
      // target for something that can never be dropped.
      if (dragRefs.current.length === 0) return;
      // Chat cells are never drop targets (user decision) — only folders get here.
      if (dragRefs.current.some((r) => r.kind === "folder" && r.id === folderId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
      setDropNode(e.currentTarget as HTMLElement);
    },
    [setDropNode]
  );

  /**
   * `dragleave` also fires when the pointer crosses from a drop target into one
   * of its own children, so an unconditional reset alternated with `dragover`
   * once per frame.
   */
  const onFolderDragLeave = useCallback(
    (e: DragEvent) => {
      const next = e.relatedTarget;
      const self = e.currentTarget as HTMLElement;
      if (next instanceof Node && self.contains(next)) return;
      if (dragPaint.current.drop === self) setDropNode(null);
    },
    [setDropNode]
  );

  /**
   * A drag can end anywhere — outside the window, on a target that never called
   * preventDefault, or with Esc. Those paths skip the cell's own `dragend`, so
   * without a document-level backstop the app would stay stuck in "dragging"
   * with cells dimmed and a folder highlighted.
   */
  useEffect(() => {
    document.addEventListener("dragend", endDrag);
    document.addEventListener("drop", endDrag);
    return () => {
      document.removeEventListener("dragend", endDrag);
      document.removeEventListener("drop", endDrag);
    };
  }, [endDrag]);

  const onFolderDrop = useCallback(
    (e: DragEvent, folderId: string) => {
      const refs = dragRefs.current;
      if (refs.length === 0) return;
      e.preventDefault();
      endDrag();
      void moveRefsTo(refs, folderId, e.ctrlKey);
    },
    [moveRefsTo, endDrag]
  );

  // --- item event handlers ------------------------------------------------------------------
  const handImpl: ItemHandlers = {
    onItemMouseDown: (e, item, index) => {
      if (editingKey === item.key) return;
      dragOccurred.current = false;
      pendingCollapse.current = null;
      setFocusKey(item.key);
      if (e.button === 2) {
        if (!selection.has(item.key)) {
          setSelection(new Set([item.key]));
          anchorIndex.current = index;
        }
        return;
      }
      if (e.shiftKey && anchorIndex.current !== null) {
        selectRange(anchorIndex.current, index, e.ctrlKey || e.metaKey);
      } else if (e.ctrlKey || e.metaKey) {
        anchorIndex.current = index;
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(item.key)) next.delete(item.key);
          else next.add(item.key);
          return next;
        });
      } else {
        anchorIndex.current = index;
        if (!selection.has(item.key)) {
          setSelection(new Set([item.key]));
        } else if (selection.size > 1) {
          pendingCollapse.current = item.key;
        }
      }
    },
    onItemClick: (e, item) => {
      const plain = !dragOccurred.current && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (pendingCollapse.current === item.key && plain) {
        setSelection(new Set([item.key]));
      }
      pendingCollapse.current = null;
      // A pile opens on a single click (user decision), like a Stack on the
      // macOS Dock. Only the first click of a burst counts: the second click
      // of a double-click would otherwise fold it straight back up. Modified
      // clicks stay pure selection gestures.
      if (item.ref.kind === "stack" && plain && e.detail <= 1) onStackToggle(item);
    },
    onItemDoubleClick: (item) => {
      if (item.ref.kind === "folder") {
        navigate({ kind: "folder", folderId: item.ref.id });
      } else if (item.ref.kind === "stack") {
        // A pile carries its newest member's chat so that sorting and the
        // preview pane work, but opening it must mean "look inside", not
        // "open whatever happens to be on top".
        onStackToggle(item);
      } else if (item.chat) {
        void openChat(item.chat);
      }
    },
    onItemContextMenu: (e, item, index) => {
      e.preventDefault();
      if (!selection.has(item.key)) {
        setSelection(new Set([item.key]));
        anchorIndex.current = index;
        setFocusKey(item.key);
      }
      setMenu({ x: e.clientX, y: e.clientY, entries: itemMenuEntries(item) });
    },
    // A check box is purely additive — it never collapses the selection the
    // way a plain click does. That is the whole point of the mode.
    onItemCheck: (item, index, checked) => {
      anchorIndex.current = index;
      setFocusKey(item.key);
      setSelection((prev) => {
        const next = new Set(prev);
        if (checked) next.add(item.key);
        else next.delete(item.key);
        return next;
      });
    },
    onStackToggle,
    onDragStart,
    onDragEnd: endDrag,
    // A pile accepts a drop the way a folder does, but an auto-stack has no
    // record to add anything to — it is recomputed from the dates — so it must
    // not even light up.
    onFolderDragOver: (e, item) => {
      if (item.ref.kind === "stack" && (autoStacked || !item.stack || isAutoStack(item.stack))) return;
      onFolderDragOver(e, item.ref.id);
    },
    onFolderDragLeave,
    onFolderDrop: (e, item) => {
      if (item.ref.kind === "stack") {
        if (autoStacked || !item.stack || isAutoStack(item.stack)) return;
        const refs = dragRefs.current;
        if (refs.length === 0) return;
        e.preventDefault();
        endDrag();
        void doAddToStack(item.ref.id, refs);
        return;
      }
      onFolderDrop(e, item.ref.id);
    },
    onRenameCommit: (item, value) => {
      setEditingKey(null);
      const trimmed = value.trim();
      if (item.ref.kind === "folder") {
        if (trimmed && trimmed !== item.name) void port.renameFolder(item.ref.id, trimmed);
      } else if (item.ref.kind === "stack") {
        // An empty name is not an error here: it hands the pile back to its
        // derived time-range label, which is the only way to undo a rename.
        void port.renameStack(item.ref.id, trimmed || null);
      } else if (item.chat) {
        const current = item.chat.displayName ?? "";
        // Typing the claude.ai title back is not a rename: store null rather
        // than an alias equal to the remote name, so the "renamed locally"
        // pencil goes away instead of marking an identical name as edited.
        const next = trimmed && trimmed !== item.chat.remoteName.trim() ? trimmed : null;
        if ((next ?? "") !== current.trim()) void port.renameChat(item.chat.uuid, next);
      }
    },
    onRenameCancel: () => setEditingKey(null)
  };

  /**
   * The views memoise their cells, and memo only helps if the handler bag keeps
   * one identity for the life of the app. `handImpl` closes over this render's
   * state and is therefore a new object every time, so it is parked in a ref and
   * reached through a frozen set of forwarders.
   */
  const handRef = useRef(handImpl);
  handRef.current = handImpl;
  const hand = useMemo<ItemHandlers>(
    () => ({
      onItemMouseDown: (e, item, i) => handRef.current.onItemMouseDown(e, item, i),
      onItemClick: (e, item, i) => handRef.current.onItemClick(e, item, i),
      onItemDoubleClick: (item) => handRef.current.onItemDoubleClick(item),
      onItemContextMenu: (e, item, i) => handRef.current.onItemContextMenu(e, item, i),
      onItemCheck: (item, i, checked) => handRef.current.onItemCheck(item, i, checked),
      onStackToggle: (item) => handRef.current.onStackToggle(item),
      onDragStart: (e, item) => handRef.current.onDragStart(e, item),
      onDragEnd: () => handRef.current.onDragEnd(),
      onFolderDragOver: (e, item) => handRef.current.onFolderDragOver(e, item),
      onFolderDragLeave: (e, item) => handRef.current.onFolderDragLeave(e, item),
      onFolderDrop: (e, item) => handRef.current.onFolderDrop(e, item),
      onRenameCommit: (item, v) => handRef.current.onRenameCommit(item, v),
      onRenameCancel: () => handRef.current.onRenameCancel()
    }),
    []
  );

  const onSelectAll = useCallback(
    (checked: boolean) => setSelection(checked ? new Set(flat.map((i) => i.key)) : new Set()),
    [flat]
  );

  // --- context menu builders ----------------------------------------------------------------
  const inHidden = effLoc.kind === "virtual" && effLoc.id === "hidden";
  /**
   * "In the bin" is now broader than "looking at the Deleted view": a deleted
   * folder can be opened and browsed, and everything inside it is still trash.
   * Creating folders, pasting, and soft-deleting all have to be off in there;
   * Del has to mean *permanently* delete instead of restore.
   */
  const inTrash =
    inHidden || (effLoc.kind === "folder" && (ctx?.hiddenFolders.has(effLoc.folderId) ?? false));

  /** Piles only exist in an icon grid over a real folder — see `foldStacks`. */
  const autoStacked = view.autoStack === "day";
  const canStack = effLoc.kind === "folder" && view.mode !== "details" && !inTrash;

  function itemMenuEntries(item: Item, trash = inTrash): MenuEntry[] {
    const refs = selection.has(item.key) ? selectedRefs() : expandRefs([item.ref]);
    const chats = refs.filter((r) => r.kind === "chat" || r.kind === "shortcut");
    const entries: MenuEntry[] = [];
    const stack = item.ref.kind === "stack" ? (item.stack ?? null) : null;

    if (trash) {
      entries.push({
        id: "restore",
        label: t("restore"),
        icon: "refresh",
        onClick: () => void doRestore(refs)
      });
      // Purge takes whatever is selected — folders, chats, shortcuts, one or
      // many. The old single-folder-only gate was the 「多选时没有彻底删除选项」
      // the user hit.
      entries.push({
        id: "purge",
        label: t("purge"),
        icon: "trash",
        shortcut: "Del",
        danger: true,
        onClick: () => doPurge(refs)
      });
      return entries;
    }

    if (stack) {
      const open = openStacks.has(stack.id);
      entries.push({
        id: "stack-toggle",
        label: open ? t("stackCollapse") : t("stackExpand"),
        icon: open ? "chevronUp" : "chevronDown",
        onClick: () => onStackToggle(item)
      });
      if (isAutoStack(stack)) {
        // Nothing to rename or dissolve — this pile is recomputed from the
        // dates every time the list is built. Say so rather than offering
        // buttons that would silently do nothing.
        entries.push({
          id: "stack-auto",
          label: t("stackAutoLocked"),
          icon: "layers",
          disabled: true,
          onClick: () => {}
        });
      } else {
        entries.push({
          id: "stack-rename",
          label: t("stackRename"),
          icon: "pencil",
          onClick: () => setEditingKey(item.key)
        });
        entries.push({
          id: "stack-dissolve",
          label: t("stackDissolve"),
          icon: "layersOff",
          onClick: () => void port.dissolveStack(stack.id)
        });
      }
      entries.push("sep");
    }

    if (item.ref.kind === "folder") {
      entries.push({
        id: "open",
        label: t("view"),
        icon: "folder",
        onClick: () => navigate({ kind: "folder", folderId: item.ref.id })
      });
    } else if (item.chat && !stack) {
      const chat = item.chat;
      entries.push({
        id: "open",
        label: t("openOnClaude"),
        icon: "externalLink",
        shortcut: "Enter",
        onClick: () => void openChat(chat)
      });
      // A shortcut is an alias, so "where does this really live?" is a question
      // it must be able to answer. The same entry is useful for a chat found in
      // a virtual view or a search result, where its folder is off-screen.
      const elsewhere = !(effLoc.kind === "folder" && effLoc.folderId === chat.folderId);
      if (item.ref.kind === "shortcut" || elsewhere) {
        entries.push({
          id: "locate",
          label: item.ref.kind === "shortcut" ? t("locateTarget") : t("showInFolder"),
          icon: "cornerUpRight",
          disabled: refs.length !== 1,
          onClick: () => revealChat(chat)
        });
      }
    }
    entries.push("sep");
    entries.push({
      id: "rename",
      label: t("rename"),
      icon: "pencil",
      shortcut: "F2",
      disabled: refs.length !== 1 || item.ref.kind === "shortcut" || item.ref.kind === "stack",
      onClick: () => setEditingKey(item.key)
    });
    if (item.chat) {
      const flagged = item.chat.flagged;
      entries.push({
        id: "flag",
        label: t("navFlagged"),
        icon: "bookmark",
        onClick: () => {
          if (!data) return;
          void port.setChatsFlagged(refsToChatUuids(refs, data, stackById), !flagged);
        }
      });
    }

    // Stacking is a property of an icon grid inside a real folder: there is no
    // slot for a pile in the details table, and a cross-folder view has no
    // folder to hang one off.
    if (canStack && !stack) {
      const picked = selection.has(item.key)
        ? allItems.filter((it) => selection.has(it.key))
        : [item];
      const n = stackableKeys(picked).length;
      entries.push("sep");
      entries.push({
        id: "stack",
        // While the day fold is on, a hand-made pile would be built and then
        // immediately hidden by it. Say why instead of failing silently.
        label: autoStacked ? t("stackAutoLocked") : t("stackCreate"),
        icon: "layers",
        disabled: autoStacked || n < STACK_MIN_MEMBERS,
        onClick: () => void doStack(picked)
      });
      if (item.inStack) {
        const host = item.inStack;
        entries.push({
          id: "unstack-one",
          label: t("stackTakeOut"),
          icon: "layersOff",
          disabled: autoStacked,
          onClick: () => void doTakeOut(host, picked)
        });
      }
    }

    entries.push("sep");
    entries.push({
      id: "cut",
      label: t("cut"),
      icon: "scissors",
      shortcut: "Ctrl+X",
      onClick: () => setClipboard({ mode: "cut", refs })
    });
    if (chats.length > 0) {
      entries.push({
        id: "copy",
        label: t("copyShortcut"),
        icon: "copy",
        shortcut: "Ctrl+C",
        onClick: () => setClipboard({ mode: "copy", refs })
      });
    }
    entries.push({
      id: "move",
      label: t("moveTo"),
      icon: "folder",
      shortcut: "M",
      onClick: () => setPicker("move")
    });
    entries.push("sep");
    // Right-clicking a selection scopes the organizer to it: selected folders
    // bring their whole subtree, loose chats (and a shortcut's target) come
    // alone. Stacks were already opened into their members by `selectedRefs`.
    entries.push({
      id: "ai",
      label: t("aiOrganizeSelection"),
      icon: "sparkle",
      onClick: () => {
        const folderIds = refs.filter((r) => r.kind === "folder").map((r) => r.id);
        const chatUuids = new Set(refs.filter((r) => r.kind === "chat").map((r) => r.id));
        for (const r of refs) {
          if (r.kind !== "shortcut") continue;
          const target = data?.shortcuts.find((sc) => sc.id === r.id)?.targetUuid;
          if (target) chatUuids.add(target);
        }
        openAgent({ kind: "items", folderIds, chatUuids: [...chatUuids] });
      }
    });
    entries.push({
      id: "delete",
      label: t("delete"),
      icon: "trash",
      shortcut: "Del",
      danger: true,
      disabled: item.ref.kind === "folder" && isSystemFolder(item.ref.id),
      onClick: () => doDelete(refs)
    });
    return entries;
  }

  function blankMenuEntries(): MenuEntry[] {
    // Nothing is authored inside the bin — no new folders, nothing pasted in.
    if (inTrash) {
      return [
        { id: "refresh", label: t("refresh"), icon: "refresh", onClick: () => void app.runSync() }
      ];
    }
    return [
      { id: "new", label: t("newFolder"), icon: "folderPlus", onClick: () => void newFolder() },
      {
        id: "paste",
        label: t("paste"),
        icon: "clipboard",
        shortcut: "Ctrl+V",
        disabled: !clipboard || effLoc.kind !== "folder",
        onClick: () => void doPaste()
      },
      "sep",
      // Blank space = the whole library (user decision).
      { id: "ai", label: t("aiOrganizeAll"), icon: "sparkle", onClick: () => openAgent({ kind: "all" }) },
      "sep",
      { id: "refresh", label: t("refresh"), icon: "refresh", onClick: () => void app.runSync() }
    ];
  }

  const anchorMenu = (anchor: HTMLElement, entries: MenuEntry[]) => {
    const box = anchor.getBoundingClientRect();
    setMenu({ x: box.right - 180, y: box.bottom + 4, entries });
  };

  /**
   * State rows carry `checked` and get a dot in the menu's left gutter, the way
   * Explorer's 查看 menu does (user decision). The old form appended " ✓" to
   * the label, which ragged the text and read as "done" rather than "current".
   * The two mode rows used `disabled` to say the same thing, which is worse
   * still — it makes the row you are on look unavailable.
   */
  const viewMenuEntries = (): MenuEntry[] => [
    {
      id: "icons",
      label: t("viewIcons"),
      icon: "layoutGrid",
      checked: view.mode === "icons",
      onClick: () => updateView({ mode: "icons" })
    },
    {
      id: "details",
      label: t("viewDetails"),
      icon: "list",
      checked: view.mode === "details",
      onClick: () => updateView({ mode: "details" })
    },
    "sep",
    {
      id: "compact",
      label: t("densityCompact"),
      checked: view.density === "compact",
      onClick: () => updateView({ density: "compact" })
    },
    {
      id: "comfortable",
      label: t("densityComfortable"),
      checked: view.density === "comfortable",
      onClick: () => updateView({ density: "comfortable" })
    },
    "sep",
    ...([32, 48, 64, 96, 128, 180] as const).map<MenuEntry>((size) => ({
      id: `size-${size}`,
      label: `${size}px`,
      checked: view.iconSize === size,
      onClick: () => updateView({ iconSize: size })
    })),
    "sep",
    ...(
      [
        ["none", t("groupNone")],
        ["month", t("groupMonth")],
        ["model", t("groupModel")],
        ["location", t("groupLocation")]
      ] as const
    ).map<MenuEntry>(([key, label]) => ({
      id: `group-${key}`,
      label: `${t("group")}: ${label}`,
      checked: view.group === key,
      onClick: () => updateView({ group: key })
    })),
    "sep",
    // Only meaningful once there is more than one group: "none" renders a single
    // unlabelled run with no header to click, so collapsing it would hide
    // everything with no visible way back.
    {
      id: "collapse-all",
      label: t("collapseAll"),
      icon: "chevronRight",
      disabled: view.group === "none" || collapsed.size === groups.length,
      onClick: () => setAllCollapsed(true)
    },
    {
      id: "expand-all",
      label: t("expandAll"),
      icon: "chevronDown",
      disabled: view.group === "none" || collapsed.size === 0,
      onClick: () => setAllCollapsed(false)
    },
    "sep",
    // The day fold is a property of this folder's view, like the sort key, so
    // it is saved with it. Hand-made piles are left in the database untouched
    // while it is on; they reappear the moment it goes off.
    {
      id: "auto-stack",
      label: t("stackAutoDay"),
      checked: autoStacked,
      disabled: !canStack,
      onClick: () => updateView({ autoStack: autoStacked ? "off" : "day" })
    },
    "sep",
    // Mirrors the Settings checkbox rather than replacing it: this is where the
    // user is standing when they decide they want them, and Explorer puts it
    // here too.
    {
      id: "checkboxes",
      label: t("showCheckboxes"),
      checked: settings?.showCheckboxes ?? false,
      onClick: () => void port.saveSettings({ showCheckboxes: !settings?.showCheckboxes })
    }
  ];

  const sortMenuEntries = (): MenuEntry[] => [
    ...(
      [
        ["name", t("sortName")],
        ["updatedAt", t("sortUpdated")],
        ["createdAt", t("sortCreated")],
        ["model", t("sortModel")],
        ["location", t("sortLocation")]
      ] as const
    ).map<MenuEntry>(([key, label]) => ({
      id: `sort-${key}`,
      label,
      checked: view.sortKey === key,
      onClick: () => updateView({ sortKey: key, sortAsc: naturalAsc(key) })
    })),
    "sep",
    {
      id: "asc",
      label: t("ascending"),
      checked: view.sortAsc,
      onClick: () => updateView({ sortAsc: true })
    },
    {
      id: "desc",
      label: t("descending"),
      checked: !view.sortAsc,
      onClick: () => updateView({ sortAsc: false })
    }
  ];

  const moreMenuEntries = (): MenuEntry[] => [
    { id: "ai", label: t("aiOrganizeAll"), icon: "sparkle", onClick: () => openAgent({ kind: "all" }) },
    { id: "history", label: t("historyTitle"), icon: "clock", onClick: () => setHistoryOpen(true) },
    { id: "export", label: t("exportData"), icon: "download", onClick: exportBackup },
    "sep",
    { id: "settings", label: t("settings"), icon: "settings", onClick: () => setSettingsOpen(true) }
  ];

  /**
   * The history panel's one verb. No confirmation: a jump is itself perfectly
   * reversible — jump back to where you were and the state returns exactly,
   * because nothing was written to the log on the way. The toast is a report,
   * not an undo offer, hence `undoable: false`.
   */
  const jumpHistory = (seq: number) => {
    void port.jumpTo(seq).then((moved) => {
      if (moved === 0) return;
      pushToast(
        moved < 0
          ? t("toastHistoryBack", { n: -moved })
          : t("toastHistoryForward", { n: moved }),
        false
      );
    });
  };

  // --- marquee ----------------------------------------------------------------------------------
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // The drag paints itself and reports once, at the end. Nothing in between
  // reaches React — see useMarquee's 2026-09-19 note.
  const marquee = useMarquee(scrollRef, {
    getSelection: () => selectionRef.current,
    onCommit: (keys) => {
      setSelection(keys);
      // A plain blank press means "nothing here is current", so the focus ring
      // goes with the selection. Folded into the commit rather than done at
      // pointerdown: one render at the end of the gesture instead of a render
      // at the worst possible moment, just as the drag is starting. A Ctrl
      // press is adding to what is there and leaves the ring alone.
      if (!blankAdditive.current) {
        setFocusKey(null);
        anchorIndex.current = null;
      }
    }
  });
  /** Whether the press that started the live marquee held Ctrl/Meta. */
  const blankAdditive = useRef(false);

  /**
   * `is-selected` is painted, not rendered — see `cellClass` in views.tsx.
   * This is the one place React's idea of the selection reaches the DOM.
   *
   * It runs after every render (no dependency array), so it also heals the
   * paint after a render that rebuilt rows for some unrelated reason, and it is
   * free when nothing moved: 1296 `classList.contains` tests and zero writes.
   * Keeping the class out of `className` is what makes a selection change cost
   * O(cells that changed) rather than a re-render of every row.
   *
   * Skipped while a marquee is live, because then the drag — not React — holds
   * the current answer, and repainting React's older one would make the
   * rectangle flicker until the next frame healed it.
   *
   * Layout effect, not a passive one: a render that rewrites `className` drops
   * `is-selected` on the way past, and only a layout effect is guaranteed to
   * put it back before the browser paints the frame.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && !marquee.isLive()) paintSelection(el, selection);
  });

  /**
   * Pointer, not mouse: `start` needs a `pointerId` to capture, which is the
   * only way to be sure the release is delivered when the drag ends off-window.
   */
  const onBlankPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-key],button,input,textarea,.details-header,.group-header")) return;
    // Native scrollbars are hidden here (ViewScrollbar draws the vertical one
    // as a sibling element, which swallows its own presses), so this test
    // normally passes. It stays as a guard: if a gutter ever comes back,
    // clientWidth/clientHeight stop at it, and a press on a native scrollbar
    // reports the scroll container itself as the target — `closest` would find
    // nothing and the marquee would start under the thumb.
    const el = e.currentTarget as HTMLElement;
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left >= el.clientWidth || e.clientY - box.top >= el.clientHeight) return;
    // 〔修订 2026-09-19 第三批〕No `setSelection` here any more. Clearing the
    // selection through React at pointerdown re-rendered the whole list inside
    // the event the browser is waiting on to begin the drag — 「框选一些之后，
    // 再立刻框选其他」. The marquee wipes the paint itself and reports the wipe
    // at pointerup, whether the press turned out to be a drag or a click.
    blankAdditive.current = e.ctrlKey || e.metaKey;
    marquee.start(e);
  };

  const onBlankContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-key]")) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entries: blankMenuEntries() });
  };

  // --- keyboard ----------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable],.pane-resizer,.agent-panel")) return;
      if (confirm || picker || settingsOpen || historyOpen) return;
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        void port.undo().then((label) => label && pushToast(`${t("undo")}: ${t(label.key, label.vars)}`, false));
      } else if ((ctrl && e.key.toLowerCase() === "y") || (ctrl && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault();
        void port.redo().then((label) => label && pushToast(`${t("redo")}: ${t(label.key, label.vars)}`, false));
      } else if (ctrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set(flat.map((i) => i.key)));
      } else if (ctrl && e.key.toLowerCase() === "x") {
        const refs = selectedRefs();
        if (refs.length > 0) setClipboard({ mode: "cut", refs });
      } else if (ctrl && e.key.toLowerCase() === "c") {
        const refs = selectedRefs().filter((r) => r.kind !== "folder");
        if (refs.length > 0) setClipboard({ mode: "copy", refs });
      } else if (ctrl && e.key.toLowerCase() === "v") {
        void doPaste();
      } else if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPicker("jump");
      } else if (e.key === "Delete") {
        // Del inside the bin is the second, terminal delete — never a restore.
        // (Restore is on the context menu, where it can't be hit by reflex.)
        if (inTrash) doPurge(selectedRefs());
        else doDelete(selectedRefs());
      } else if (e.key === "F2") {
        e.preventDefault();
        startRename();
      } else if (e.key.toLowerCase() === "m" && !ctrl) {
        if (selection.size > 0) {
          e.preventDefault();
          setPicker("move");
        }
      } else if (e.key === "Enter") {
        const key = focusKey ?? [...selection][0];
        const item = key ? itemByKey.get(key) : undefined;
        if (item) hand.onItemDoubleClick(item);
      } else if (e.key === "Escape") {
        // Escape peels off one layer at a time, innermost first. The clipboard
        // sits above the selection because a pending cut is the more alarming
        // state to be stuck in: those items are drawn dimmed and look deleted,
        // and there was previously no way at all to call the cut off.
        if (menu) setMenu(null);
        else if (searchQuery) setSearchQuery("");
        else if (clipboard) setClipboard(null);
        else setSelection(new Set());
      } else if (e.key === "Backspace") {
        e.preventDefault();
        goUp();
      } else if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight"
      ) {
        const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
        // Details is one item per row, so left/right carry no meaning there and
        // are left to the browser (they scroll a narrow pane horizontally).
        if (horizontal && view.mode !== "icons") return;
        e.preventDefault();

        const key = focusKey ?? [...selection][0];
        const index = key ? flat.findIndex((i) => i.key === key) : -1;
        // The grid wraps, so "down" is a whole row, not one cell. The column
        // count comes from the laid-out grid (auto-fill means it is not known
        // ahead of time) and only matters in icons mode.
        const stride =
          !horizontal && view.mode === "icons" && key ? gridColumns(scrollRef.current, key) : 1;
        const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
        const next = index < 0 ? 0 : index + (back ? -stride : stride);
        // Out of range means the edge of the list: stay put rather than snapping
        // to the first/last item, which is what a grid is expected to do.
        if (index >= 0 && (next < 0 || next >= flat.length)) return;

        const item = flat[next];
        if (item) {
          setFocusKey(item.key);
          if (e.shiftKey && anchorIndex.current !== null) selectRange(anchorIndex.current, next, false);
          else {
            anchorIndex.current = next;
            setSelection(new Set([item.key]));
          }
          scrollRef.current
            ?.querySelector(`[data-key="${CSS.escape(item.key)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // --- auto sync ----------------------------------------------------------------------------------
  const bootSynced = useRef(false);
  useEffect(() => {
    if (bootSynced.current || !app.auth?.signedIn) return;
    if (app.lastSyncAt === null && data !== null) {
      bootSynced.current = true;
      void app.runSync();
    }
  }, [app.auth, app.lastSyncAt, data, app.runSync]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const minutes = settings?.autoSyncMinutes ?? 0;
    if (minutes <= 0) return;
    const timer = setInterval(() => void app.runSync(), minutes * 60_000);
    return () => clearInterval(timer);
  }, [settings?.autoSyncMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- pickers ------------------------------------------------------------------------------------
  const folderOptions: PickerOption[] = useMemo(() => {
    if (!ctx || !data) return [];
    return data.folders
      .filter((f) => !f.hidden && !ctx.hiddenFolders.has(f.id))
      .map((f) => ({
        id: f.id,
        name: folderDisplayName(f, t),
        icon: "folder" as const,
        path: folderPath(data.folders, f.id)
          .slice(0, -1)
          .map((p) => folderDisplayName(p, t))
          .join(" / ")
      }));
  }, [ctx, data, t]);

  const jumpOptions: PickerOption[] = useMemo(() => {
    if (!ctx || !data) return [];
    const chats: PickerOption[] = listItems(ctx, { kind: "virtual", id: "recent" }).map((i) => ({
      id: i.key,
      name: i.name,
      icon: "fileText" as const
    }));
    const all: PickerOption[] = data.chats
      .filter((c) => !c.hidden)
      .map((c) => ({
        id: `chat:${c.uuid}`,
        name: (c.displayName ?? c.remoteName).trim() || c.uuid.slice(0, 8),
        icon: "fileText" as const
      }));
    const folders = folderOptions.map((f) => ({ ...f, id: `folder:${f.id}` }));
    const seen = new Set<string>();
    const merged: PickerOption[] = [];
    for (const option of [...folders, ...chats, ...all]) {
      if (!seen.has(option.id)) {
        seen.add(option.id);
        merged.push(option);
      }
    }
    return merged;
  }, [ctx, data, folderOptions]);

  const pickerFilter = (option: PickerOption, query: string) =>
    normalizeForSearch(option.name).includes(normalizeForSearch(query));

  // --- render --------------------------------------------------------------------------------------
  if (!data || !settings || !ctx) {
    return <div className="app" />;
  }

  const counts = countsFor(ctx);
  const selectedChatItems = [...selection]
    .map((k) => itemByKey.get(k))
    .filter((i): i is Item => !!i && !!i.chat);
  // A lone selected pile gets its own preview; its `chat` is only the card
  // drawn on top, and describing that one chat would misdescribe the pile.
  const previewStack =
    selectedChatItems.length === 1 && selectedChatItems[0]?.stack ? selectedChatItems[0] : null;
  const previewChat =
    selectedChatItems.length === 1 && !previewStack ? (selectedChatItems[0]?.chat ?? null) : null;

  const shortcutsOf = (uuid: string) =>
    data.shortcuts
      .filter((s) => s.targetUuid === uuid)
      .map((s) => folderPathLabel(data.folders, s.folderId, t));

  const emptyState = (() => {
    if (allItems.length > 0) return null;
    if (effLoc.kind === "search") {
      return { title: t("emptySearchTitle"), body: t("emptySearchBody", { q: searchQuery }) };
    }
    if (inHidden) return { title: t("emptyHiddenTitle"), body: "" };
    if (effLoc.kind === "folder" && effLoc.folderId === UNFILED_ID) {
      return { title: t("emptyUnfiledTitle"), body: t("emptyUnfiledBody") };
    }
    return { title: t("emptyFolderTitle"), body: t("emptyFolderBody") };
  })();

  const viewProps = {
    groups,
    flat,
    view,
    folders: data.folders,
    selection,
    cutKeys,
    focusKey,
    editingKey,
    // `dropKey` / `draggingKeys` used to live here. They are decoration during a
    // gesture that must not re-render 1296 cells, so they are painted straight
    // onto the DOM instead — see the drag & drop block above.
    collapsed,
    onToggleGroup,
    openStacks,
    checkboxes: settings.showCheckboxes,
    onSelectAll,
    peekFor,
    hand,
    t,
    lang
  };

  return (
    <div className="app">
      {app.auth && !app.auth.signedIn && (
        <div className="banner">
          <Icon className="banner-icon" name="alert" size={16} />
          <span>{t("sessionExpired")}</span>
          <button onClick={() => window.open("https://claude.ai/", "_blank", "noopener")}>
            {t("openClaudeToSignIn")}
          </button>
        </div>
      )}

      <Toolbar
        location={location}
        folders={data.folders}
        canBack={hist.index > 0}
        canForward={hist.index < hist.stack.length - 1}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onNavigate={navigate}
        searchQuery={searchQuery}
        onSearch={setSearchQuery}
        syncing={app.syncing}
        onSync={() => void app.runSync()}
        onNewFolder={() => void newFolder()}
        canNewFolder={!inTrash}
        previewOpen={!!previewOpen}
        onTogglePreview={() => setPreviewOpen((p) => !p)}
        onOpenViewMenu={(anchor) => anchorMenu(anchor, viewMenuEntries())}
        onOpenSortMenu={(anchor) => anchorMenu(anchor, sortMenuEntries())}
        onOpenMoreMenu={(anchor) => anchorMenu(anchor, moreMenuEntries())}
        virtualLabel={(id: VirtualId) =>
          t(
            (
              {
                recent: "navRecent",
                flagged: "navFlagged",
                starred: "navStarred",
                missing: "navMissing",
                hidden: "navHidden"
              } as const
            )[id]
          )
        }
        t={t}
      />

      <div className="app-main">
        <NavTree
          folders={data.folders}
          hiddenFolders={ctx.hiddenFolders}
          counts={counts}
          location={location}
          onNavigate={navigate}
          onFolderContextMenu={(e, folderId) => {
            e.preventDefault();
            const item = itemByKey.get(`folder:${folderId}`) ?? {
              ref: { kind: "folder" as const, id: folderId },
              key: `folder:${folderId}`,
              name: data.folders.find((f) => f.id === folderId)?.name ?? "",
              folder: data.folders.find((f) => f.id === folderId)
            };
            // The tree only shows live folders, so its menu is never the bin's
            // menu even when the content pane is showing the bin.
            setMenu({ x: e.clientX, y: e.clientY, entries: itemMenuEntries(item, false) });
          }}
          onFolderDragOver={onFolderDragOver}
          onFolderDragLeave={onFolderDragLeave}
          onFolderDrop={onFolderDrop}
          width={navWidth}
          t={t}
        />
        <PaneResizer
          side="left"
          width={navWidth}
          limits={PANE_LIMITS.nav}
          onResize={(w) => setPaneWidths((p) => (p ? { ...p, nav: w } : p))}
          onCommit={(w) => void port.saveSettings({ navWidth: w })}
          label={t("resizeNav")}
        />

        <div className="app-content">
          <div
            ref={scrollRef}
            className="view-scroll"
            onPointerDown={onBlankPointerDown}
            onContextMenu={onBlankContextMenu}
          >
            {emptyState ? (
              <div className="empty-state" style={{ height: "100%" }}>
                <h3>{emptyState.title}</h3>
                {emptyState.body && <p>{emptyState.body}</p>}
              </div>
            ) : view.mode === "details" ? (
              <DetailsView
                {...viewProps}
                onSortBy={(key) =>
                  updateView(
                    view.sortKey === key
                      ? { sortAsc: !view.sortAsc }
                      : { sortKey: key, sortAsc: naturalAsc(key) }
                  )
                }
                // Arrives once, on pointerup — the drag itself never comes
                // through React, it writes the CSS variable directly.
                onColumnResize={(col, width) =>
                  updateView({ columnWidths: { ...view.columnWidths, [col]: width } })
                }
              />
            ) : (
              <IconView {...viewProps} />
            )}
            {/* Permanent, and moved by hand: mounting/unmounting it — or even
                restyling it through React — would re-render the whole list on
                every frame of a drag. */}
            <div className="marquee" ref={marquee.rectRef} hidden />
          </div>

          <ViewScrollbar
            scrollRef={scrollRef}
            revision={`${view.mode}:${view.density}:${view.iconSize}:${flat.length}:${groups.length}:${previewOpen}`}
          />

          <StatusBar
            itemCount={allItems.length}
            selectedCount={selection.size}
            auth={app.auth}
            syncing={app.syncing}
            syncProgress={app.syncProgress}
            syncError={app.syncError}
            lastSyncAt={app.lastSyncAt}
            lang={lang}
            t={t}
          />
        </div>

        {agent && (
          <>
            <PaneResizer
              side="right"
              width={agentWidth}
              limits={PANE_LIMITS.agent}
              onResize={(w) => setPaneWidths((p) => (p ? { ...p, agent: w } : p))}
              onCommit={(w) => void port.saveSettings({ agentWidth: w })}
              label={t("resizeAgent")}
            />
            <AgentPanel
              request={agent}
              folders={data.folders}
              chats={data.chats}
              width={agentWidth}
              lang={lang}
              t={t}
              onClose={() => {
                agentBusy.current = false;
                setAgent(null);
              }}
              onOpenSettings={() => setSettingsOpen(true)}
              onCommitted={onAgentCommitted}
              onRunningChange={(r) => {
                agentBusy.current = r;
              }}
              onToast={(text) => pushToast(text, false)}
            />
          </>
        )}
        {!agent && previewOpen && (
          <PaneResizer
            side="right"
            width={previewWidth}
            limits={PANE_LIMITS.preview}
            onResize={(w) => setPaneWidths((p) => (p ? { ...p, preview: w } : p))}
            onCommit={(w) => void port.saveSettings({ previewWidth: w })}
            label={t("resizePreview")}
          />
        )}
        {!agent && previewOpen && previewStack?.stack && (
          <StackPreview
            name={previewStack.name}
            stack={previewStack.stack}
            open={openStacks.has(previewStack.stack.id)}
            folders={data.folders}
            onToggle={() => onStackToggle(previewStack)}
            onDissolve={
              previewStack.stack.record
                ? () => void port.dissolveStack(previewStack.ref.id)
                : null
            }
            onReveal={(memberKey) => {
              if (!openStacks.has(previewStack.ref.id)) onStackToggle(previewStack);
              setSelection(new Set([memberKey]));
              setFocusKey(memberKey);
            }}
            width={previewWidth}
            lang={lang}
            t={t}
          />
        )}
        {!agent && previewOpen && !previewStack && (
          <PreviewPane
            chat={previewChat}
            selectedCount={selectedChatItems.length}
            folders={data.folders}
            shortcutsOf={shortcutsOf}
            onSaveNotes={(uuid, notes) => void port.setNotes(uuid, notes)}
            onOpen={(chat) => void openChat(chat)}
            onMoveTo={() => setPicker("move")}
            width={previewWidth}
            lang={lang}
            t={t}
          />
        )}
      </div>

      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} t={t} />}
      {menu && <ContextMenu spec={menu} onClose={() => setMenu(null)} />}
      {picker === "move" && (
        <Picker
          placeholder={t("folderPickerPlaceholder")}
          options={folderOptions}
          filter={pickerFilter}
          onPick={(folderId) => void moveRefsTo(selectedRefs(), folderId, false)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "jump" && (
        <Picker
          placeholder={t("quickJumpPlaceholder")}
          options={jumpOptions}
          filter={pickerFilter}
          onPick={(id) => {
            if (id.startsWith("folder:")) {
              navigate({ kind: "folder", folderId: id.slice("folder:".length) });
            } else if (id.startsWith("chat:")) {
              const uuid = id.slice("chat:".length);
              const chat = data.chats.find((c) => c.uuid === uuid);
              if (chat) revealChat(chat);
            }
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          counts={{
            chats: data.chats.length,
            lastSync: app.lastSyncAt
              ? formatWhen(app.lastSyncAt, lang)
              : t("syncNever")
          }}
          onSave={(patch) => void port.saveSettings(patch)}
          onClose={() => setSettingsOpen(false)}
          onSyncNow={() => void app.runSync()}
          t={t}
        />
      )}
      {historyOpen && (
        <HistoryPanel
          onJump={jumpHistory}
          onClose={() => setHistoryOpen(false)}
          t={t}
          lang={lang}
        />
      )}
      <ToastHost toasts={toasts} onExpire={expireToast} />
    </div>
  );
}

function formatWhen(ts: number, lang: "zh-CN" | "en"): string {
  const d = new Date(ts);
  return d.toLocaleString(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
