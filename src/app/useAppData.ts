import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthStatus } from "../claude/api";
import { getMeta } from "../core/db";
import { historyState, type HistoryState } from "../core/ops";
import { META_KEY, type FolderView } from "../core/schema";
import { loadSettings, type Settings } from "../core/settings";
import { snapshot, type Snapshot } from "../core/store";
import { loadViews } from "../core/views";
import type { SyncProgress, SyncResult } from "../claude/sync";
import { onDataChanged, port } from "./dataport";
import { onSyncProgress, requestAuth } from "./messaging";

export interface AppData {
  data: Snapshot | null;
  views: Map<string, FolderView>;
  settings: Settings | null;
  history: HistoryState;
  lastSyncAt: number | null;
  auth: AuthStatus | null;
  syncing: boolean;
  /** Live phase of the running sync, or null when idle. */
  syncProgress: SyncProgress | null;
  syncError: string | null;
  /** The last completed sync, for the "done" report. Cleared when a new one starts. */
  syncDone: SyncResult | null;
  refresh: () => Promise<void>;
  runSync: () => Promise<void>;
}

/**
 * Loads everything the shell needs and re-reads on every data-port
 * notification (local or from another tab). Reads are direct IndexedDB
 * access; writes must go through `port`.
 */
export function useAppData(): AppData {
  const [data, setData] = useState<Snapshot | null>(null);
  const [views, setViews] = useState<Map<string, FolderView>>(new Map());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<HistoryState>({ undoLabel: null, redoLabel: null });
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDone, setSyncDone] = useState<SyncResult | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const [snap, viewRows, prefs, hist, last] = await Promise.all([
      snapshot(),
      loadViews(),
      loadSettings(),
      historyState(),
      getMeta<number>(META_KEY.lastSyncAt)
    ]);
    if (!alive.current) return;
    setData(snap);
    setViews(viewRows);
    setSettings(prefs);
    setHistory(hist);
    setLastSyncAt(last ?? null);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    requestAuth().then(
      (status) => {
        if (alive.current) setAuth(status);
      },
      () => {
        if (alive.current) setAuth({ signedIn: false, reason: "unreachable" });
      }
    );
    const off = onDataChanged(() => void refresh());
    // Subscribed for the whole life of the page, not just while a sync we
    // started is running: a sync can also be kicked off from another app tab,
    // and this one should still show what is happening.
    const offProgress = onSyncProgress((p) => {
      if (alive.current) setSyncProgress(p);
    });
    return () => {
      alive.current = false;
      off();
      offProgress();
    };
  }, [refresh]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncDone(null);
    setSyncProgress({ phase: "auth", fetched: 0 });
    try {
      const result = await port.sync();
      if (alive.current) setSyncDone(result);
      const status = await requestAuth();
      if (alive.current) setAuth(status);
    } catch (e) {
      if (alive.current) setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) {
        setSyncing(false);
        setSyncProgress(null);
      }
    }
  }, []);

  return {
    data,
    views,
    settings,
    history,
    lastSyncAt,
    auth,
    syncing,
    syncProgress,
    syncError,
    syncDone,
    refresh,
    runSync
  };
}
