import type { Broadcast, Request, Response } from "../background";
import type { AuthStatus } from "../claude/api";
import type { SyncProgress, SyncResult } from "../claude/sync";

async function send<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T>;
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export const requestSync = () => send<SyncResult>({ type: "sync" });
export const requestAuth = () => send<AuthStatus>({ type: "auth" });

/**
 * Subscribes to the worker's sync progress. Returns an unsubscribe function.
 *
 * The listener must return nothing (not `true`), or this page would claim it is
 * going to answer a broadcast that has no sender waiting.
 */
export function onSyncProgress(fn: (p: SyncProgress) => void): () => void {
  // Outside the extension (the dev server) there is no worker to listen to;
  // without this the whole app page fails to mount there.
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => {};
  const handle = (msg: unknown) => {
    const m = msg as Partial<Broadcast> | null;
    if (!m || m.type !== "syncProgress" || m.phase === undefined) return;
    fn({ phase: m.phase, fetched: m.fetched ?? 0 });
  };
  chrome.runtime.onMessage.addListener(handle);
  return () => chrome.runtime.onMessage.removeListener(handle);
}
