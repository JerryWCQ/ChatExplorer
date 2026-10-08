import "fake-indexeddb/auto";
import { beforeEach, expect, test, vi } from "vitest";
import { getMeta, idb, tx } from "../core/db";
import { META_KEY, ROOT_ID, STORE, UNFILED_ID, type Chat } from "../core/schema";
import {
  createFolder,
  moveChats,
  renameChat,
  setChatsFlagged,
  setChatsHidden,
  setNotes,
  snapshot
} from "../core/store";
import { AuthError } from "./api";
import { fullSync } from "./sync";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** Mirrors a real chat_conversations_v2 row, including the fields we ignore. */
function remote(uuid: string, overrides: Record<string, unknown> = {}) {
  return {
    uuid,
    name: `remote ${uuid.slice(0, 4)}`,
    summary: "some summary",
    model: "claude-opus-5",
    created_at: "2026-09-01T00:00:00.000000Z",
    updated_at: "2026-09-17T07:36:09.377297Z",
    is_starred: false,
    is_temporary: false,
    project_uuid: null,
    last_read_at: "2026-09-17T07:26:09Z",
    settings: { enabled_web_search: true, thinking_mode: "auto" },
    platform: "CLAUDE_AI",
    current_leaf_message_uuid: "0392f0ae-ea61-4c29-922a-999d4e594a99",
    ...overrides
  };
}

const ORGS = [
  { uuid: "api-org", name: "Individual", capabilities: ["api", "api_individual"] },
  { uuid: "chat-org", name: "Personal", capabilities: ["chat", "claude_pro"] }
];

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  );
}

/** Serves orgs plus `pages` of conversations, honouring limit/offset like the real API. */
function mockApi(conversations: unknown[], opts: { orgStatus?: number } = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/organizations")) {
      return opts.orgStatus ? json({ type: "error" }, opts.orgStatus) : json(ORGS);
    }
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get("limit"));
    const offset = Number(parsed.searchParams.get("offset"));
    const slice = conversations.slice(offset, offset + limit);
    return json({ data: slice, has_more: offset + slice.length < conversations.length });
  });
}

beforeEach(async () => {
  await tx(
    [STORE.folders, STORE.chats, STORE.shortcuts, STORE.transactions, STORE.meta],
    "readwrite",
    async (t) => {
      for (const store of [STORE.chats, STORE.shortcuts, STORE.transactions, STORE.meta]) {
        t.objectStore(store).clear();
      }
      const folders = await idb.getAll<{ id: string }>(t, STORE.folders);
      for (const f of folders) {
        if (f.id !== ROOT_ID && f.id !== UNFILED_ID) await idb.del(t, STORE.folders, f.id);
      }
    }
  );
});

test("first sync files every conversation under Unfiled", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A), remote(B)]));

  const result = await fullSync();
  expect(result).toMatchObject({ total: 2, added: 2, missing: 0 });

  const chats = (await snapshot()).chats;
  expect(chats).toHaveLength(2);
  expect(chats.every((c) => c.folderId === UNFILED_ID)).toBe(true);
  expect(chats[0]?.remoteName).toMatch(/^remote /);
  expect(await getMeta(META_KEY.orgId)).toBe("chat-org");
});

test("the chat org is chosen by capability, not by position", async () => {
  const fetchMock = mockApi([remote(A)]);
  vi.stubGlobal("fetch", fetchMock);
  await fullSync();

  const listUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("chat_conv"));
  expect(listUrl).toContain("/organizations/chat-org/");
});

test("re-syncing never clobbers the user's folder, name or note", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A)]));
  await fullSync();

  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([A], work);
  await renameChat(A, "My own title");
  await setNotes(A, "worth revisiting");

  vi.stubGlobal("fetch", mockApi([remote(A, { name: "server renamed it", updated_at: "2026-09-18T00:00:00Z" })]));
  const result = await fullSync();
  expect(result).toMatchObject({ added: 0, updated: 1 });

  const chat = (await snapshot()).chats.find((c) => c.uuid === A)!;
  expect(chat.folderId).toBe(work);
  expect(chat.displayName).toBe("My own title");
  expect(chat.notes).toBe("worth revisiting");
  expect(chat.remoteName).toBe("server renamed it");
  expect(chat.updatedAt).toBe("2026-09-18T00:00:00Z");
});

test("a conversation that vanishes upstream is flagged, not deleted", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A), remote(B)]));
  await fullSync();
  const work = await createFolder(ROOT_ID, "Work");
  await moveChats([B], work);

  vi.stubGlobal("fetch", mockApi([remote(A)]));
  const result = await fullSync();
  expect(result).toMatchObject({ total: 1, missing: 1 });

  const gone = (await snapshot()).chats.find((c) => c.uuid === B)!;
  expect(gone.status).toBe("missing");
  expect(gone.folderId).toBe(work);
});

test("a conversation that comes back is restored in place", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A), remote(B)]));
  await fullSync();
  vi.stubGlobal("fetch", mockApi([remote(A)]));
  await fullSync();

  vi.stubGlobal("fetch", mockApi([remote(A), remote(B)]));
  const result = await fullSync();
  expect(result).toMatchObject({ restored: 1, missing: 0 });
  expect((await snapshot()).chats.find((c) => c.uuid === B)?.status).toBe("active");
});

function manyRemote(n: number) {
  return Array.from({ length: n }, (_, i) =>
    remote(`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`)
  );
}

test("pagination walks every page", async () => {
  const many = manyRemote(2300);
  const fetchMock = mockApi(many);
  vi.stubGlobal("fetch", fetchMock);

  const result = await fullSync();
  expect(result.total).toBe(2300);
  expect((await snapshot()).chats).toHaveLength(2300);

  // Deliberately not asserting a page *count*: the page size is a tuning knob
  // (see PAGE_SIZE in api.ts) and pinning it here would turn every retune into
  // a red test. What matters is that more than one request happened and that
  // the walk stopped instead of running to the loop guard.
  const pages = fetchMock.mock.calls.filter((c) => String(c[0]).includes("chat_conv"));
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.length).toBeLessThan(50);
});

test("progress reports rise to the total and end in the write phase", async () => {
  vi.stubGlobal("fetch", mockApi(manyRemote(700)));

  const seen: { phase: string; fetched: number }[] = [];
  const result = await fullSync((p) => seen.push({ ...p }));

  expect(seen[0]?.phase).toBe("auth");
  expect(seen.at(-1)).toEqual({ phase: "write", fetched: 700 });

  // The count the user watches must never go backwards, or "n so far" reads as
  // a bug even when the sync is fine.
  const counts = seen.filter((p) => p.phase === "list").map((p) => p.fetched);
  expect(counts.length).toBeGreaterThan(1);
  expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  expect(counts.at(-1)).toBe(result.total);
});

test("a request that never answers gives up instead of hanging", async () => {
  // The three-minute sync this guards against was not an error — it was a
  // `fetch` that sat there. In a service worker that is completely silent, so
  // the only defence is a deadline. There is no `chrome` in this environment,
  // so the tab fallback reports itself unavailable and the run ends in a
  // TransportError, which is the honest outcome: both transports are dead.
  vi.useFakeTimers();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );

    const run = fullSync();
    const settled = run.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;

    expect(outcome).toContain("organizations:");
    expect(outcome).toMatch(/no answer within/);
  } finally {
    vi.useRealTimers();
  }
});

test("a row repeated across pages is counted once", async () => {
  // Offset paging plus a conversation created mid-pull shifts later rows down,
  // so the same uuid can legitimately arrive twice. The total must not inflate.
  const rows = manyRemote(400);
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/organizations")) return json(ORGS);
    const offset = Number(new URL(url).searchParams.get("offset"));
    const limit = Number(new URL(url).searchParams.get("limit"));
    // Every page after the first re-serves its predecessor's last row.
    const from = offset === 0 ? 0 : offset - 1;
    const slice = rows.slice(from, from + limit);
    return json({ data: slice, has_more: from + slice.length < rows.length });
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await fullSync();
  expect(result.total).toBe(400);
  expect((await snapshot()).chats).toHaveLength(400);
});

test("a rejected session surfaces as AuthError", async () => {
  vi.stubGlobal("fetch", mockApi([], { orgStatus: 403 }));
  await expect(fullSync()).rejects.toBeInstanceOf(AuthError);
});

test("sync leaves the undo stack alone", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A)]));
  await fullSync();
  const log = await tx([STORE.transactions], "readonly", (t) =>
    idb.getAll<unknown>(t, STORE.transactions)
  );
  expect(log).toHaveLength(0);
});

test("local-only fields start empty for a brand new chat", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A)]));
  await fullSync();
  const chat = (await snapshot()).chats.find((c) => c.uuid === A) as Chat;
  expect(chat.displayName).toBeNull();
  expect(chat.notes).toBe("");
  expect(chat.summary).toBe("some summary");
  expect(chat.status).toBe("active");
  expect(chat.flagged).toBe(false);
  expect(chat.hidden).toBe(false);
  expect(chat.pos).toBeNull();
});

test("a locally deleted chat is not resurrected by the next sync", async () => {
  vi.stubGlobal("fetch", mockApi([remote(A), remote(B)]));
  await fullSync();
  await setChatsHidden([A], true);
  await setChatsFlagged([B], true);

  vi.stubGlobal("fetch", mockApi([remote(A), remote(B, { name: "renamed" })]));
  await fullSync();

  const chats = (await snapshot()).chats;
  expect(chats.find((c) => c.uuid === A)?.hidden).toBe(true);
  expect(chats.find((c) => c.uuid === B)?.flagged).toBe(true);
  expect(chats.find((c) => c.uuid === B)?.remoteName).toBe("renamed");
});
