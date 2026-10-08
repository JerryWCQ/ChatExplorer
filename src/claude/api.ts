/**
 * Reading claude.ai's private API.
 *
 * Two transports, tried in that order:
 *
 *  1. A plain `fetch` from wherever this module runs (normally the service
 *     worker). Cheapest, needs no open tab, and it is the intended path.
 *  2. The same request executed *inside* an open claude.ai tab via
 *     `chrome.scripting`. Needs a tab, needs the `scripting` permission, and
 *     borrows the page's own network stack — so it survives cookie-partitioning
 *     rules and bot checks that reject extension-originated requests.
 *
 * **Transport 2 is a fallback and must never become the normal path.** It costs
 * a tab, it breaks the moment that tab navigates away, and a silent fallback
 * hides the day transport 1 stops working. So the choice is scoped to a single
 * run: `resetTransport()` at the start of every sync throws the choice away and
 * makes the next request probe `direct` again. Within a run the winner is
 * sticky, because a sync makes several requests and there is no point paying a
 * failed direct attempt on each one.
 *
 * Read-only by construction: only GET, and nothing here ever writes to claude.ai.
 */

const ORIGIN = "https://claude.ai";
const BASE = `${ORIGIN}/api`;

/** Thrown when claude.ai rejects us — almost always a signed-out or expired session. */
export class AuthError extends Error {
  constructor(public status: number) {
    super(`claude.ai returned ${status} — sign in at claude.ai and try again.`);
    this.name = "AuthError";
  }
}

/** Thrown when neither transport could produce a usable response. */
export class TransportError extends Error {
  constructor(
    message: string,
    public detail: { direct: string; viaTab: string }
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface RemoteConversation {
  uuid: string;
  name: string;
  summary: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  is_starred: boolean;
  is_temporary: boolean;
  project_uuid: string | null;
  last_read_at: string | null;
}

interface Raw {
  status: number;
  body: string;
}

/**
 * Runs INSIDE a claude.ai page. Self-contained — `executeScript` serialises the
 * source, so it can close over nothing, not even `BASE`.
 */
function fetchInPage(url: string): Promise<Raw> {
  return fetch(url, { credentials: "include" }).then(
    async (r) => ({ status: r.status, body: await r.text() }),
    (e: unknown) => ({ status: 0, body: `fetch failed in page: ${String(e)}` })
  );
}

/**
 * Every request is time-boxed, because the failure this whole file is written
 * around is not an error — it is a `fetch` that never comes back. A hung
 * request in a service worker is completely silent, and the user experiences it
 * as "sync took three minutes and said nothing".
 *
 * Two ceilings, because the two situations are not the same:
 *
 *   PROBE — the request that decides the transport for the run. Nothing is
 *   committed yet, a healthy answer takes well under a second, so give up early
 *   and let the fallback have its turn.
 *
 *   REQUEST — everything after. A page is ~1.6s healthy (see PAGE_SIZE), so 30s
 *   is roughly twenty times the budget: slow enough to survive a bad hotel
 *   connection, fast enough that a hang becomes a fallback rather than a hang.
 */
const PROBE_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 30_000;

async function direct(path: string, timeoutMs: number): Promise<Raw> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      signal: abort.signal
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    if (abort.signal.aborted) return { status: 0, body: `no answer within ${timeoutMs}ms` };
    return { status: 0, body: `fetch failed: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tab transport has no AbortController to reach — the fetch is running in
 * another world — so the ceiling is a race. A loser left running in the page is
 * harmless: it is a GET, and nothing is listening to it any more.
 */
function withDeadline(work: Promise<Raw>, timeoutMs: number): Promise<Raw> {
  return Promise.race([
    work,
    new Promise<Raw>((resolve) =>
      setTimeout(() => resolve({ status: 0, body: `no answer within ${timeoutMs}ms` }), timeoutMs)
    )
  ]);
}

async function viaTabOnce(path: string): Promise<Raw> {
  if (typeof chrome === "undefined" || !chrome.scripting || !chrome.tabs) {
    return { status: 0, body: "no scripting API in this context" };
  }
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  } catch (e) {
    return { status: 0, body: `tabs.query failed: ${String(e)}` };
  }
  const tab = tabs.find((t) => t.id !== undefined);
  if (!tab || tab.id === undefined) {
    return { status: 0, body: "no claude.ai tab is open" };
  }
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: fetchInPage,
      args: [`${BASE}${path}`]
    });
    const value = hit?.result as Raw | undefined;
    return value ?? { status: 0, body: "injected fetch returned nothing" };
  } catch (e) {
    return { status: 0, body: `executeScript failed: ${String(e)}` };
  }
}

const viaTab = (path: string, timeoutMs: number): Promise<Raw> =>
  withDeadline(viaTabOnce(path), timeoutMs);

export type Transport = "direct" | "tab";

/**
 * The transport for the current run, decided by its first request. Null means
 * "not decided yet", which is what makes the next request start from `direct`.
 */
let chosen: Transport | null = null;

/** Which transport last worked — surfaced in the UI so a fallback is visible, not silent. */
export let lastTransport: Transport | null = null;

/**
 * Forgets the transport choice so the next request probes `direct` again.
 * Called at the top of every sync: without it, one bad afternoon would pin the
 * whole session to the tab path and we would never notice it had recovered.
 */
export function resetTransport(): void {
  chosen = null;
  lastTransport = null;
}

async function get<T>(path: string): Promise<T> {
  // Undecided runs probe direct on a short leash; a decided run leads with the
  // winner and keeps the other as a backstop for a tab that closed mid-sync.
  const deciding = chosen === null;
  const order: Transport[] = chosen === "tab" ? ["tab", "direct"] : ["direct", "tab"];
  const notes: Record<string, string> = { direct: "not tried", tab: "not tried" };
  // Only a transport that actually reached claude.ai gets a vote on whether
  // this is an auth problem; one that never left the browser knows nothing.
  let denied = 0;

  const budget = deciding ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

  for (const how of order) {
    const raw = how === "direct" ? await direct(path, budget) : await viaTab(path, budget);

    if (raw.status >= 200 && raw.status < 300) {
      try {
        const parsed = JSON.parse(raw.body) as T;
        chosen = how;
        lastTransport = how;
        return parsed;
      } catch {
        // A 200 that is not JSON is a challenge/interstitial page, not data.
        notes[how] = `HTTP ${raw.status} but body was not JSON (${raw.body.slice(0, 80)})`;
        continue;
      }
    }
    if (raw.status === 401 || raw.status === 403) denied = raw.status;
    notes[how] = raw.status === 0 ? raw.body.slice(0, 160) : `HTTP ${raw.status}`;
  }

  // "Sign in again" is only honest advice when the server itself said no.
  if (denied) throw new AuthError(denied);

  throw new TransportError(
    `claude.ai ${path} failed — direct: ${notes.direct}; via tab: ${notes.tab}`,
    { direct: notes.direct!, viaTab: notes.tab! }
  );
}

interface RemoteOrg {
  uuid: string;
  name: string;
  capabilities: string[];
}

/**
 * An account exposes several orgs (the chat one plus an API-only one); the chat
 * org is identified by capability, never by position.
 */
export async function fetchChatOrgId(): Promise<string> {
  const orgs = await get<RemoteOrg[]>("/organizations");
  const org = orgs.find((o) => (o.capabilities ?? []).includes("chat"));
  if (!org) throw new Error("No organization on this account has chat access.");
  return org.uuid;
}

/**
 * Measured against the live account on 2026-09-18, ~1300 conversations, one
 * request at a time:
 *
 *   limit=1  → 0.51s      limit=200 → 1.58s  (561 KB)
 *   limit=50 → 0.81s      limit=500 → 2.52s  (1.6 MB)
 *
 * About 400ms of fixed cost plus ~4ms a row, so the whole list is a handful of
 * seconds at any page size and the choice is not about throughput.
 *
 * The first attempt at this measurement ran three probes at once and produced
 * 28s, 52s and 77s for the same requests — a 20–30× penalty. **Concurrent
 * requests on one session are punished far out of proportion**, which is why
 * the loop below is strictly sequential and must stay that way. It is also the
 * likeliest explanation for the three-minute sync this replaces, together with
 * a direct transport that was being retried, and hanging, on every page.
 *
 * Given that, the page size is chosen for feedback and for safety: a page is
 * the only unit of progress there is, and an MV3 service worker is killed when
 * it looks idle, so shorter requests are a better bet. 200 gives ~7 pages of
 * ~1.6s — often enough for the count to visibly move, few enough that the
 * per-request overhead stays under a fifth of the total.
 */
const PAGE_SIZE = 200;

/**
 * Hard stop on the paging loop. Not paranoia: a server that keeps answering
 * `has_more: true` with a full page would otherwise spin forever inside a
 * service worker, where a spin is completely invisible.
 */
const MAX_CONVERSATIONS = 100_000;

export interface FetchProgress {
  /** Conversations received so far. */
  fetched: number;
  /** Pages completed so far. */
  pages: number;
}

/**
 * Pages until the server says it is done, reporting after each page.
 *
 * De-duplicates by uuid because paging is offset-based: a conversation created
 * while the pull is running shifts every later row down one, and at a minute
 * per pull that is not a hypothetical. Duplicates would otherwise inflate the
 * "n chats" the sync reports.
 */
export async function fetchConversations(
  orgId: string,
  onProgress?: (p: FetchProgress) => void
): Promise<RemoteConversation[]> {
  const byUuid = new Map<string, RemoteConversation>();
  let pages = 0;

  for (let offset = 0; offset < MAX_CONVERSATIONS; ) {
    const page = await get<{ data: RemoteConversation[]; has_more: boolean }>(
      `/organizations/${orgId}/chat_conversations_v2?limit=${PAGE_SIZE}&offset=${offset}`
    );
    for (const conv of page.data) byUuid.set(conv.uuid, conv);
    pages++;
    onProgress?.({ fetched: byUuid.size, pages });

    if (!page.has_more || page.data.length === 0) break;
    offset += page.data.length;
  }

  return [...byUuid.values()];
}

export type AuthStatus =
  | { signedIn: true; orgId: string }
  | { signedIn: false; reason: string };

export async function checkAuth(): Promise<AuthStatus> {
  try {
    return { signedIn: true, orgId: await fetchChatOrgId() };
  } catch (e) {
    return { signedIn: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
