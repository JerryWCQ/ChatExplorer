import { checkAuth, type AuthStatus } from "../claude/api";
import { fullSync, type SyncProgress, type SyncResult } from "../claude/sync";

const APP_PAGE = "app.html";

export type Request = { type: "sync" } | { type: "auth" };
export type Response<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Pushed at the app page while a sync runs. A broadcast rather than a reply,
 * because the reply cannot arrive until the sync is over and the whole point is
 * to say something during the minute before that.
 */
export type Broadcast = { type: "syncProgress" } & SyncProgress;

async function openApp(): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE);
  const { appTabId } = await chrome.storage.session.get("appTabId");
  if (typeof appTabId === "number") {
    try {
      await chrome.tabs.update(appTabId, { active: true });
      return;
    } catch {
      // Tab is gone; fall through and open a new one.
    }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ appTabId: tab.id });
}

chrome.action.onClicked.addListener(() => {
  void openApp();
});

/**
 * Fire-and-forget. With no app page listening this rejects with "no receiving
 * end", which is not an error worth failing a sync over.
 */
function broadcast(msg: Broadcast): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* extension context torn down */
  }
}

chrome.runtime.onMessage.addListener(
  (req: Request, _sender, sendResponse: (r: Response<SyncResult | AuthStatus>) => void) => {
    // Our own progress broadcasts come back through this listener. Ignore
    // anything that is not a request, or a broadcast would be answered as if it
    // were an auth check.
    if (!req || (req.type !== "sync" && req.type !== "auth")) return false;

    const run = async () => {
      if (req.type === "sync") {
        return await fullSync((p) => broadcast({ type: "syncProgress", ...p }));
      }
      return await checkAuth();
    };
    run().then(
      (value) => sendResponse({ ok: true, value }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
    );
    return true;
  }
);
