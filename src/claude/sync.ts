import { idb, setMeta, tx } from "../core/db";
import { META_KEY, STORE, UNFILED_ID, type Chat } from "../core/schema";
import {
  fetchChatOrgId,
  fetchConversations,
  lastTransport,
  resetTransport,
  type RemoteConversation,
  type Transport
} from "./api";

export interface SyncResult {
  total: number;
  added: number;
  updated: number;
  missing: number;
  restored: number;
  ms: number;
  /** Which API transport carried it — see `api.ts`. Shown so a fallback is never silent. */
  transport: Transport | null;
}

/**
 * What a sync is doing right now. A healthy full pull of ~1300 conversations is
 * about ten seconds — but it is ten seconds of nothing visible, and when the
 * direct transport is sick it has been three minutes of nothing visible. Either
 * way the cure is the same: say which phase it is in, and keep a count moving
 * while the long one runs.
 */
export type SyncPhase = "auth" | "list" | "write";

export interface SyncProgress {
  phase: SyncPhase;
  /** Conversations received so far; only meaningful during `list`. */
  fetched: number;
}

export type ProgressFn = (p: SyncProgress) => void;

/**
 * Names the phase a failure happened in. Without this every failure arrives as
 * a bare HTTP or IndexedDB message and there is no way to tell "claude.ai said
 * no" from "the local database said no" — which need completely different
 * fixes from the user.
 *
 * Prefixes the message in place rather than wrapping, because callers switch on
 * `instanceof AuthError` and a wrapper would hide it.
 */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Error) {
      e.message = `${label}: ${e.message}`;
      throw e;
    }
    throw new Error(`${label}: ${String(e)}`);
  }
}

function merge(remote: RemoteConversation, existing: Chat | undefined, now: number): Chat {
  return {
    uuid: remote.uuid,
    // Everything the user owns survives a sync untouched. `hidden` especially:
    // clearing it here would resurrect every locally deleted chat on every sync.
    folderId: existing?.folderId ?? UNFILED_ID,
    displayName: existing?.displayName ?? null,
    notes: existing?.notes ?? "",
    firstSeenAt: existing?.firstSeenAt ?? now,
    flagged: existing?.flagged ?? false,
    hidden: existing?.hidden ?? false,
    pos: existing?.pos ?? null,

    remoteName: remote.name ?? "",
    summary: remote.summary ?? "",
    model: remote.model ?? null,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
    isStarred: !!remote.is_starred,
    isTemporary: !!remote.is_temporary,
    projectUuid: remote.project_uuid ?? null,
    lastReadAt: remote.last_read_at ?? null,
    status: "active",
    lastSyncedAt: now
  };
}

/**
 * Pulls the entire conversation list and reconciles it into IndexedDB. The server
 * returns everything in one request at this account's scale, so a full pull is
 * both cheap and the simplest correct way to notice deletions.
 *
 * Deliberately bypasses the undo log: a sync is not a user action.
 *
 * `onProgress` is optional so tests and one-off callers can ignore it, but the
 * background worker always passes one — see `background/index.ts`.
 */
export async function fullSync(onProgress?: ProgressFn): Promise<SyncResult> {
  const started = Date.now();

  // Every run re-probes the direct transport; the tab path is a fallback, not
  // a habit the session can fall into. See the header of `api.ts`.
  resetTransport();

  onProgress?.({ phase: "auth", fetched: 0 });
  const orgId = await step("organizations", () => fetchChatOrgId());
  await step("save org id", () => setMeta(META_KEY.orgId, orgId));

  onProgress?.({ phase: "list", fetched: 0 });
  const remote = await step("conversation list", () =>
    fetchConversations(orgId, (p) => onProgress?.({ phase: "list", fetched: p.fetched }))
  );

  onProgress?.({ phase: "write", fetched: remote.length });
  const now = Date.now();
  const result = await step("local write", () =>
    tx([STORE.chats], "readwrite", async (t) => {
      const existing = await idb.getAll<Chat>(t, STORE.chats);
      const byUuid = new Map(existing.map((c) => [c.uuid, c]));
      const seen = new Set<string>();
      let added = 0;
      let updated = 0;
      let restored = 0;

      for (const conv of remote) {
        seen.add(conv.uuid);
        const prev = byUuid.get(conv.uuid);
        if (!prev) added++;
        else {
          if (prev.status === "missing") restored++;
          updated++;
        }
        await idb.put(t, STORE.chats, merge(conv, prev, now));
      }

      let missing = 0;
      for (const chat of existing) {
        if (seen.has(chat.uuid)) continue;
        missing++;
        if (chat.status !== "missing") await idb.put(t, STORE.chats, { ...chat, status: "missing" });
      }

      return { added, updated, missing, restored };
    })
  );

  await setMeta(META_KEY.lastSyncAt, now);
  return {
    ...result,
    total: remote.length,
    ms: Date.now() - started,
    transport: lastTransport
  };
}
