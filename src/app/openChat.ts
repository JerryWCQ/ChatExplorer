/**
 * Opening a conversation.
 *
 * `window.open` makes claude.ai cold-start its whole app. Measured on the real
 * site (2026-09-18): a fresh tab reaches `load` at ~4.8s, while switching
 * conversations inside a tab that is already running lands in ~1.5–3s. So the
 * fast path asks an existing claude.ai tab to do a client-side route change,
 * and only falls back to a real page load when that cannot be made to work.
 *
 * claude.ai runs **TanStack Router** (not Next.js, despite what the framework
 * fingerprints used to suggest): `history.state` carries `__TSR_index` /
 * `__TSR_key`, and the router instance is published on `window.__TSR_ROUTER__`.
 * All four strategies below were verified against the live site; the order is
 * cleanest-first, and each one is kept because the one above it depends on an
 * internal that could disappear.
 *
 * Everything here is written to degrade quietly: the injected script verifies
 * its own effect and undoes itself on failure, and every step is wrapped so a
 * missing permission or a closed tab just means the next strategy runs.
 */

import { chatUrl } from "../core/schema";
import type { OpenMode } from "../core/settings";

/** What actually happened, for the caller to report or log. */
export type OpenOutcome =
  | { kind: "newTab" }
  | { kind: "focused" }
  | { kind: "inPage"; via: string; ms: number }
  | { kind: "reloaded" };

/**
 * Runs INSIDE the claude.ai page, in the main world. Must be self-contained:
 * `chrome.scripting.executeScript` serialises the function source, so it can
 * close over nothing.
 *
 * Returns the strategy that worked, or null if the page was left untouched.
 */
function navigateInPage(uuid: string): Promise<{ via: string; ms: number } | null> {
  const path = `/chat/${uuid}`;
  const started = performance.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * TanStack Router commits the new location only after the route loader
   * settles, so the URL itself lags the call by a second or more. Measured
   * worst case on the live site was 3.0s; 8s leaves room for a slow network
   * without making a genuine failure feel like a hang.
   */
  const TIMEOUT_MS = 8000;

  /**
   * A real navigation churned 23–33 nodes in the measurements, so the old
   * `> 30` threshold would have rejected most successes. What this guard is
   * actually for is the degenerate case where the address bar moves and
   * nothing else does, and a handful of mutations already rules that out.
   */
  const MIN_MUTATIONS = 8;

  const tsr = (): {
    navigate?: (opts: { to: string }) => unknown;
    history?: { push?: (href: string) => void };
  } | null => (window as unknown as Record<string, any>).__TSR_ROUTER__ ?? null;

  /**
   * Last-ditch route to the router if the global is ever removed: walk the
   * fiber tree for a context value carrying the router's signature methods.
   * The React container lives on `#root` on claude.ai — `document.body` has no
   * fiber key, which is why the roots are listed explicitly.
   */
  const findRouterOnFiber = (): { navigate?: (o: { to: string }) => unknown } | null => {
    const roots: (Element | null)[] = [
      document.getElementById("root"),
      document.body.firstElementChild,
      document.body
    ];
    for (const el of roots) {
      if (!el) continue;
      const key = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")
      );
      if (!key) continue;
      let fiber = (el as unknown as Record<string, any>)[key];
      let hops = 0;
      while (fiber && hops++ < 300) {
        const v = fiber.memoizedProps && fiber.memoizedProps.value;
        if (v && typeof v.navigate === "function" && typeof v.buildLocation === "function") {
          return v;
        }
        fiber = fiber.return || fiber.child;
      }
    }
    return null;
  };

  const strategies: { name: string; run: () => boolean }[] = [
    {
      name: "tsr.navigate",
      run: () => {
        const r = tsr();
        if (!r || typeof r.navigate !== "function") return false;
        r.navigate({ to: path });
        return true;
      }
    },
    {
      name: "tsr.history.push",
      run: () => {
        const r = tsr();
        if (!r || !r.history || typeof r.history.push !== "function") return false;
        r.history.push(path);
        return true;
      }
    },
    {
      name: "fiber.navigate",
      run: () => {
        const r = findRouterOnFiber();
        if (!r || typeof r.navigate !== "function") return false;
        r.navigate({ to: path });
        return true;
      }
    },
    {
      name: "anchor.click",
      run: () => {
        // A link the app rendered itself carries the framework's own click
        // handler, so this is a genuine client-side navigation — but only for
        // conversations that happen to be in the sidebar right now.
        const a = document.querySelector<HTMLAnchorElement>(`a[href$="${path}"]`);
        if (!a) return false;
        a.click();
        return true;
      }
    },
    {
      name: "history.pushState",
      run: () => {
        // TanStack Router patches pushState and re-commits through its own
        // pipeline, so this works today — but it is last because on any router
        // that does *not* patch it, this only rewrites the address bar, which
        // is worse than a reload. Hence the verification below is mandatory.
        history.pushState(null, "", path);
        return true;
      }
    }
  ];

  return (async () => {
    const from = location.pathname + location.search;

    for (const s of strategies) {
      if (location.pathname.includes(uuid)) break;

      // A URL change alone proves nothing: pushState can move the address bar
      // while leaving the old conversation on screen, which is worse than a
      // reload. So require the document to actually churn as well.
      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const title0 = document.title;

      let fired = false;
      try {
        fired = s.run();
      } catch {
        fired = false;
      }

      if (!fired) {
        observer.disconnect();
        continue;
      }

      let ok = false;
      for (let waited = 0; waited < TIMEOUT_MS; waited += 50) {
        await sleep(50);
        if (
          location.pathname.includes(uuid) &&
          (mutations >= MIN_MUTATIONS || document.title !== title0)
        ) {
          ok = true;
          break;
        }
      }
      observer.disconnect();

      if (ok) return { via: s.name, ms: Math.round(performance.now() - started) };

      // Leave no trace for the next strategy (or for the hard-load fallback).
      if (location.pathname !== from) history.replaceState(null, "", from);
    }

    return null;
  })();
}

/** claude.ai tabs, most recently used first. */
async function claudeTabs(): Promise<chrome.tabs.Tab[]> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    // `lastAccessed` is not everywhere yet; active tabs sort first regardless.
    return tabs.sort((a, b) => {
      const av = (a.active ? 1e15 : 0) + ((a as { lastAccessed?: number }).lastAccessed ?? 0);
      const bv = (b.active ? 1e15 : 0) + ((b as { lastAccessed?: number }).lastAccessed ?? 0);
      return bv - av;
    });
  } catch {
    return [];
  }
}

async function focus(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* window gone */
    }
  }
}

export async function openChatTab(uuid: string, mode: OpenMode): Promise<OpenOutcome> {
  const url = chatUrl(uuid);

  if (mode !== "newTab") {
    const tabs = await claudeTabs();

    // Already showing this conversation: nothing to do but come to the front.
    const exact = tabs.find((t) => t.url?.startsWith(url));
    if (exact) {
      await focus(exact);
      return { kind: "focused" };
    }

    if (mode === "reuseTab" && tabs.length > 0) {
      const tab = tabs[0]!;
      if (tab.id !== undefined) {
        // Focus *before* navigating, not after: the route change takes a
        // second or more, and watching it happen reads as "it's working"
        // where a frozen explorer window followed by a jump does not.
        try {
          await focus(tab);
        } catch {
          /* tab or window gone; the calls below will fail the same way */
        }
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: navigateInPage,
            args: [uuid]
          });
          const value = result?.result as { via: string; ms: number } | null | undefined;
          if (value) return { kind: "inPage", via: value.via, ms: value.ms };
        } catch {
          // No scripting permission, a restricted page, or the injected script
          // was torn down by a navigation it caused. Fall through.
        }
        // Client-side routing is unavailable: still reuse the tab rather than
        // piling up new ones — a reload in place is what the user asked for
        // minus the speed.
        try {
          await chrome.tabs.update(tab.id, { url, active: true });
          return { kind: "reloaded" };
        } catch {
          /* fall through to a new tab */
        }
      }
    }
  }

  window.open(url, "_blank", "noopener");
  return { kind: "newTab" };
}
