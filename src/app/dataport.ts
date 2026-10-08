/**
 * The data port: the app's single write entry (approved deviation to DESIGN
 * 0.6). Components may READ IndexedDB freely — snapshot(), loadViews(),
 * loadSettings() — but every WRITE goes through `port`, which notifies this
 * tab's subscribers and broadcasts to any other open ChatExplorer tabs over a
 * BroadcastChannel, so all windows converge without polling.
 *
 * Sync is included: it runs in the background service worker, but its
 * completion is a data change like any other and must fan out the same way.
 */

import { saveAiConfig } from "../agent/config";
import {
  jumpBefore as opsJumpBefore,
  jumpTo as opsJumpTo,
  redo as opsRedo,
  undo as opsUndo
} from "../core/ops";
import { saveSettings } from "../core/settings";
import * as store from "../core/store";
import { resetView, saveView } from "../core/views";
import { requestSync } from "./messaging";

const CHANNEL = "chatexplorer-data";

type Listener = () => void;
const listeners = new Set<Listener>();

const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
if (bc) {
  bc.onmessage = () => {
    for (const fn of [...listeners]) fn();
  };
}

/** Subscribe to "some data changed, re-read what you need". Returns unsubscribe. */
export function onDataChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of [...listeners]) fn();
  bc?.postMessage("changed");
}

/** Wraps a mutation so completion always notifies, success or not re-thrown. */
function writes<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const result = await fn(...args);
    notify();
    return result;
  };
}

export const port = {
  // folders
  createFolder: writes(store.createFolder),
  renameFolder: writes(store.renameFolder),
  moveFolder: writes(store.moveFolder),
  setFolderHidden: writes(store.setFolderHidden),
  purgeRefs: writes(store.purgeRefs),

  // chats
  setChatsHidden: writes(store.setChatsHidden),
  restoreRefs: writes(store.restoreRefs),
  setChatsFlagged: writes(store.setChatsFlagged),
  moveChats: writes(store.moveChats),
  renameChat: writes(store.renameChat),
  setNotes: writes(store.setNotes),

  // shortcuts
  createShortcuts: writes(store.createShortcuts),
  moveShortcuts: writes(store.moveShortcuts),
  deleteShortcuts: writes(store.deleteShortcuts),

  // stacks
  createStack: writes(store.createStack),
  dissolveStack: writes(store.dissolveStack),
  renameStack: writes(store.renameStack),
  addToStack: writes(store.addToStack),
  removeFromStack: writes(store.removeFromStack),

  // free layout
  setPositions: writes(store.setPositions),

  // history
  undo: writes(opsUndo),
  redo: writes(opsRedo),
  /** Wind the log to a chosen point — the history panel's one and only verb. */
  jumpTo: writes(opsJumpTo),
  /** Wind the log to just before a step — the AI organizer's rewind. */
  jumpBefore: writes(opsJumpBefore),

  // AI organizer: one batch = one undo step; its connection settings
  applyAgentOps: writes(store.applyAgentOps),
  saveAiConfig: writes(saveAiConfig),

  // per-folder view state + settings (not undoable, still broadcast)
  saveView: writes(saveView),
  resetView: writes(resetView),
  saveSettings: writes(saveSettings),

  // sync runs in the service worker; the local index changes when it lands
  sync: writes(requestSync)
} as const;
