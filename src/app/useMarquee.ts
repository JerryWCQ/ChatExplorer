/**
 * Marquee selection over the shared scroll container. Works in every view
 * (user decision): the caller starts it from any blank-area mousedown, the
 * hook tracks the rectangle in CONTENT coordinates (scroll-independent),
 * auto-scrolls when the pointer nears the container edges, and reports hits
 * by intersecting the rect with every element carrying a data-key attribute.
 *
 * Ctrl held at drag start = append: the hit set is unioned with the selection
 * as it was when the drag began.
 *
 * Three things here exist for performance, because this loop has to stay
 * smooth over folders with thousands of items:
 *
 *  1. Item boxes are measured ONCE, when the drag goes live, and kept in
 *     content coordinates. The old code called getBoundingClientRect() on
 *     every [data-key] node on every frame — a few thousand forced layouts per
 *     frame, which is exactly the stutter the user reported.
 *  2. The hit test is skipped entirely when neither the rectangle nor the
 *     scroll offset moved since the last frame.
 *  3. Nothing the drag does touches React state. See below.
 *
 * ---
 *
 * 〔修订 2026-09-18〕**Ending the drag is the hard part, not running it.**
 *
 * This used to end on a `mouseup` listener bound to `window`. A plain
 * `mousedown` does not capture the pointer, so releasing the button outside the
 * browser window delivers no `mouseup` to the page at all — and the edge
 * auto-scroll below makes dragging out of the window the *normal* way to reach
 * the bottom of a long list. When that happened the rAF loop never stopped.
 *
 * A leaked loop is invisible in a short list: the stale pointer position does
 * not move, the rectangle does not change, and the hit test is skipped. Move to
 * a location that actually scrolls and it becomes catastrophic — the stale
 * pointer is parked in the edge zone, so every frame scrolls the container,
 * re-measures and re-hit-tests, forever.
 *
 * So the drag now takes a real pointer capture, which guarantees delivery of
 * `pointerup`/`pointercancel` wherever the pointer is, and four independent
 * backstops end it anyway if that guarantee is ever broken: a lost capture,
 * window blur, page hide, and a `buttons` check on every move. Starting a drag
 * also tears down any previous one first, so two loops can never coexist.
 *
 * ---
 *
 * 〔修订 2026-09-19〕**A live drag must not go through React at all.**
 *
 * Ending the leaked loop only halved the problem. Even a perfectly bounded drag
 * was pushing two state updates through App — the rectangle (every frame) and
 * the hit set (on every change) — and App renders 1296 cells. `memo` keeps the
 * cell *bodies* from re-rendering, but React still has to create and reconcile
 * 1296 elements each time, which is the cost that survived: "反复框选和切换
 * folder 后依旧会很卡很卡".
 *
 * So the drag is now fully imperative. The rectangle is a permanent div the
 * caller hands over as `rectRef`, positioned by writing to `style`. Hits are
 * painted by toggling `is-selected` on the item nodes directly. React learns
 * the answer exactly once, from `onCommit`, when the pointer comes up.
 *
 * The paint pass compares against the DOM rather than against a remembered set,
 * so it is self-healing: if App happens to re-render mid-drag for an unrelated
 * reason and React restores `is-selected` from its own state, the next frame
 * simply puts the drag's answer back.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";

const EDGE = 28;
const MAX_SPEED = 18;

/**
 * Floor between two full re-measures of the item boxes.
 *
 * `contain-intrinsic-size: auto …` on the cells means the container's
 * scrollHeight keeps shifting as auto-scroll reveals cells whose real height
 * was only guessed until now. That is the signal we invalidate the box cache
 * on — but taken literally it fires on almost every frame of a long scroll, and
 * a re-measure is one `getBoundingClientRect()` per item. At a thousand-odd
 * items that is the per-frame forced layout the cache was built to avoid.
 */
const REMEASURE_MS = 120;

/** An item box in content coordinates: fixed for the lifetime of one drag. */
interface Box {
  key: string;
  node: HTMLElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeHandlers {
  /** The selection as React currently knows it; read once, at drag start. */
  getSelection: () => Set<string>;
  /** The drag's verdict, delivered once, when the pointer comes up. */
  onCommit: (keys: Set<string>) => void;
}

const EMPTY: Set<string> = new Set();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * Paint one cell. Reading `classList.contains` first means an unchanged node
 * costs nothing — no attribute write, so no style recalc.
 *
 * 〔修订 2026-09-19 第三批〕This is now the *only* writer of `is-selected`
 * anywhere in the app: the cell components no longer put it in `className`, so
 * a selection change costs a sweep like this one instead of a re-render of
 * every row. See `paintSelection` and App's selection-paint effect.
 */
function paintNode(node: HTMLElement, want: boolean): void {
  if (node.classList.contains("is-selected") !== want) {
    node.classList.toggle("is-selected", want);
  }
  // The check box is uncontrolled for the same reason — React would have to
  // re-render the row to move it, and moving it by hand is one property write.
  const cb = node.querySelector<HTMLInputElement>("input.checkbox");
  if (cb && cb.checked !== want) cb.checked = want;
}

/**
 * Bring every cell under `root` in line with `target`. Cheap enough to run
 * after every render of the app — at 1296 rows it is 1296 `contains` tests and
 * only the handful that actually differ touch the DOM.
 */
export function paintSelection(root: HTMLElement, target: Set<string>): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-key]")) {
    paintNode(node, target.has(node.dataset.key!));
  }
}

function paint(boxes: Box[], target: Set<string>): void {
  for (const b of boxes) paintNode(b.node, target.has(b.key));
}

export function useMarquee(scrollRef: RefObject<HTMLDivElement | null>, handlers: MarqueeHandlers) {
  /** The rectangle element, owned by the caller, written to directly. */
  const rectRef = useRef<HTMLDivElement>(null);

  // Parked in a ref so `start` can keep one identity for the life of the app:
  // it is reached from a pointerdown handler, and a new one every render would
  // defeat nothing here but costs a closure per render for no reason.
  const hand = useRef(handlers);
  hand.current = handlers;

  const state = useRef<{
    startX: number;
    startY: number;
    clientX: number;
    clientY: number;
    /** Selection to union with the hits; empty unless Ctrl started the drag. */
    base: Set<string>;
    raf: number;
    active: boolean;
    /**
     * A non-additive press wipes the selection. The wipe is painted at once but
     * only reported at the end, so a press that turns out to be a plain click
     * still clears — and a press that turns into a drag reports its own verdict
     * instead. Either way React hears about it exactly once.
     */
    cleared: boolean;
    boxes: Box[] | null;
    /** scrollHeight the boxes were measured at; a change means re-measure. */
    measuredAt: number;
    /** performance.now() of that measurement, for the REMEASURE_MS floor. */
    measuredMs: number;
    last: Rect | null;
    hits: Set<string>;
    /** base ∪ hits — what the DOM is painted with and what gets committed. */
    result: Set<string>;
  } | null>(null);

  /**
   * Undoes everything the live drag installed. Held in a ref rather than closed
   * over so `start` can end a previous drag it did not create — see the header:
   * two live loops is the failure mode, not one loop that ran too long.
   */
  const teardown = useRef<(() => void) | null>(null);

  /**
   * Client→content. clientWidth/clientHeight exclude the scrollbar gutters, so
   * clamping to them keeps the rectangle inside the visible content area. That
   * is what stops the right-edge runaway: an unclamped rect grows past the
   * container, inflates scrollWidth (it is an absolutely positioned child of
   * the scroller), which re-arms the horizontal auto-scroll, which grows the
   * rect further — the loop the user saw.
   */
  const toContent = useCallback(
    (clientX: number, clientY: number) => {
      const el = scrollRef.current!;
      const box = el.getBoundingClientRect();
      return {
        x: clamp(clientX, box.left, box.left + el.clientWidth) - box.left + el.scrollLeft,
        y: clamp(clientY, box.top, box.top + el.clientHeight) - box.top + el.scrollTop
      };
    },
    [scrollRef]
  );

  const measure = useCallback((container: HTMLElement): Box[] => {
    const cbox = container.getBoundingClientRect();
    const dx = container.scrollLeft - cbox.left;
    const dy = container.scrollTop - cbox.top;
    const out: Box[] = [];
    for (const node of container.querySelectorAll<HTMLElement>("[data-key]")) {
      const b = node.getBoundingClientRect();
      out.push({
        key: node.dataset.key!,
        node,
        left: b.left + dx,
        top: b.top + dy,
        right: b.right + dx,
        bottom: b.bottom + dy
      });
    }
    return out;
  }, []);

  /**
   * `commit` is false for the paths that are not a finished gesture — unmount,
   * a new drag starting on top of this one. Handing React a selection in those
   * cases would either warn (setState on an unmounted tree) or overwrite what
   * the new drag is about to decide.
   */
  const end = useCallback((commit: boolean) => {
    const s = state.current;
    state.current = null;
    if (s) cancelAnimationFrame(s.raf);
    const undo = teardown.current;
    teardown.current = null;
    undo?.();
    const box = rectRef.current;
    if (box) box.hidden = true;
    // A drag that never left the dead zone is a click. It still has something
    // to say if it wiped the selection on the way in — that wipe is only in the
    // DOM until this call puts it into React.
    if (commit && s && (s.active || s.cleared)) hand.current.onCommit(s.result);
  }, []);

  const finish = useCallback(() => end(true), [end]);

  useEffect(() => () => end(false), [end]);

  /** Call from pointerdown on blank space (left button only, caller checks target). */
  const start = useCallback(
    (e: {
      clientX: number;
      clientY: number;
      ctrlKey: boolean;
      metaKey: boolean;
      pointerId: number;
    }) => {
      const el = scrollRef.current;
      if (!el) return;
      // Never two live drags: whatever is running loses, now, before anything
      // new is installed.
      end(false);
      const origin = toContent(e.clientX, e.clientY);
      const additive = e.ctrlKey || e.metaKey;
      const base = additive ? new Set(hand.current.getSelection()) : new Set<string>();
      const st = {
        startX: origin.x,
        startY: origin.y,
        clientX: e.clientX,
        clientY: e.clientY,
        base,
        raf: 0,
        active: false,
        cleared: !additive,
        boxes: null as Box[] | null,
        measuredAt: 0,
        measuredMs: 0,
        last: null as Rect | null,
        hits: new Set<string>(),
        result: new Set(base)
      };
      state.current = st;

      // 〔修订 2026-09-19 第三批〕The wipe used to be a `setSelection(new Set())`
      // in the caller's pointerdown handler — a full re-render of the list,
      // synchronously, inside the event the browser is waiting on to start the
      // drag. With a few hundred rows still selected from the previous sweep
      // that is exactly the 「框选一些之后，再立刻框选其他」 stall. Painting it
      // here costs one class toggle per formerly-selected node and nothing else.
      if (!additive) paintSelection(el, EMPTY);

      const frame = () => {
        const s = state.current;
        const container = scrollRef.current;
        if (!s || !container) return;

        const box = container.getBoundingClientRect();
        // Clamp to the content area, not the border box: past the scrollbar the
        // pointer should pin to the edge, not keep pushing the rectangle out.
        const px = clamp(s.clientX, box.left, box.left + container.clientWidth);
        const py = clamp(s.clientY, box.top, box.top + container.clientHeight);

        // Edge auto-scroll: speed proportional to how deep into the edge zone.
        // An axis with nothing to scroll is skipped so it cannot feed the loop
        // described above.
        const before = { x: container.scrollLeft, y: container.scrollTop };
        if (container.scrollHeight > container.clientHeight) {
          const dyTop = py - box.top;
          const dyBottom = box.top + container.clientHeight - py;
          if (dyTop < EDGE) container.scrollTop -= ((EDGE - dyTop) / EDGE) * MAX_SPEED;
          else if (dyBottom < EDGE) container.scrollTop += ((EDGE - dyBottom) / EDGE) * MAX_SPEED;
        }
        if (container.scrollWidth > container.clientWidth) {
          const dxLeft = px - box.left;
          const dxRight = box.left + container.clientWidth - px;
          if (dxLeft < EDGE) container.scrollLeft -= ((EDGE - dxLeft) / EDGE) * MAX_SPEED;
          else if (dxRight < EDGE) container.scrollLeft += ((EDGE - dxRight) / EDGE) * MAX_SPEED;
        }
        const scrolled = container.scrollLeft !== before.x || container.scrollTop !== before.y;

        const now = toContent(s.clientX, s.clientY);
        const r: Rect = {
          left: Math.min(s.startX, now.x),
          top: Math.min(s.startY, now.y),
          width: Math.abs(now.x - s.startX),
          height: Math.abs(now.y - s.startY)
        };

        // A 4px dead zone so a sloppy click does not clear the selection.
        if (!s.active && (r.width > 4 || r.height > 4)) s.active = true;

        if (s.active) {
          const moved =
            s.last === null ||
            s.last.left !== r.left ||
            s.last.top !== r.top ||
            s.last.width !== r.width ||
            s.last.height !== r.height;

          if (moved || scrolled) {
            s.last = r;
            const div = rectRef.current;
            if (div) {
              div.style.left = `${r.left}px`;
              div.style.top = `${r.top}px`;
              div.style.width = `${r.width}px`;
              div.style.height = `${r.height}px`;
              div.hidden = false;
            }

            // Measure once per drag. Auto-scrolling reveals cells that
            // content-visibility had skipped, which can nudge scrollHeight, so
            // that value is the cheap invalidation signal — rate-limited,
            // because during a long auto-scroll it changes nearly every frame
            // and a re-measure is a rect read per item.
            const at = performance.now();
            if (
              s.boxes === null ||
              (s.measuredAt !== container.scrollHeight && at - s.measuredMs > REMEASURE_MS)
            ) {
              s.boxes = measure(container);
              s.measuredAt = container.scrollHeight;
              s.measuredMs = at;
            }

            const right = r.left + r.width;
            const bottom = r.top + r.height;
            const hits = new Set<string>();
            for (const b of s.boxes) {
              if (b.left < right && b.right > r.left && b.top < bottom && b.bottom > r.top) {
                hits.add(b.key);
              }
            }
            if (!sameSet(hits, s.hits)) {
              s.hits = hits;
              s.result = s.base.size === 0 ? hits : new Set([...s.base, ...hits]);
            }
            // Painted every frame the rect moved, not only when the hit set
            // changed: a re-measure can hand back fresh nodes for rows that
            // React replaced, and this is what re-applies the drag's answer to
            // them. Unchanged nodes cost one classList.contains each.
            paint(s.boxes, s.result);
          }
        }
        s.raf = requestAnimationFrame(frame);
      };

      const move = (ev: PointerEvent) => {
        const s = state.current;
        if (!s) return;
        // Backstop 4: the button came up somewhere we never heard about. Bit 0
        // of `buttons` is the primary button; zero means nothing is held, so
        // whatever this move is, it is not part of a drag.
        if ((ev.buttons & 1) === 0) {
          finish();
          return;
        }
        s.clientX = ev.clientX;
        s.clientY = ev.clientY;
      };

      el.addEventListener("pointermove", move);
      // Backstops 1–3. `pointerup`/`pointercancel` are the real ending;
      // `lostpointercapture` covers a capture taken away from us (another
      // element grabbing it, or the browser doing it during a native drag);
      // blur and pagehide cover the window going away mid-drag.
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);
      el.addEventListener("lostpointercapture", finish);
      window.addEventListener("blur", finish);
      document.addEventListener("visibilitychange", finish);

      teardown.current = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", finish);
        el.removeEventListener("pointercancel", finish);
        el.removeEventListener("lostpointercapture", finish);
        window.removeEventListener("blur", finish);
        document.removeEventListener("visibilitychange", finish);
        // Releasing a capture we no longer hold throws; there is nothing to
        // recover from either way.
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      };

      // The whole point: with the pointer captured, the release is delivered to
      // this element wherever it happens — including outside the window, which
      // the edge auto-scroll makes an ordinary place to end a drag.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture unavailable; the backstops above still end the drag */
      }

      st.raf = requestAnimationFrame(frame);
    },
    [scrollRef, toContent, end, finish, measure]
  );

  /**
   * True between pointerdown and the end of the gesture. Callers use it to keep
   * out of the way: while a drag is live the DOM, not React, holds the current
   * selection.
   */
  const isLive = useCallback(() => state.current !== null, []);

  return { start, rectRef, isLive };
}
