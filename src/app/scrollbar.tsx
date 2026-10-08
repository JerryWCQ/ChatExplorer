/**
 * A self-drawn vertical scrollbar for the one scroll container.
 *
 * Why not the native one: a native scrollbar's gutter lives *outside*
 * `clientWidth`, so nothing can be painted over it and pointer events on it
 * never reach a child. That blocks two things at once — a stuck group header
 * cannot extend its background across the track, and a press on the empty part
 * of the track cannot start a marquee. Drawing the thumb ourselves solves both:
 * the track stops being a gutter and becomes ordinary content.
 *
 * The component owns its own state so a scroll never re-renders App (and with
 * it 1296 memoised cells). Measurement is rAF-coalesced and does all its reads
 * before any write, so a fast scroll cannot thrash layout.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent
} from "react";

/** Sticky elements the track has to start below. Both live inside .view-scroll. */
const STICKY_SELECTOR = ".details-header, .group-header";
const MIN_THUMB = 28;

interface Geometry {
  /** Thumb offset from the top of the *positioned* parent (.app-content). */
  top: number;
  height: number;
  /** Pixels of thumb travel, i.e. track height minus thumb height. */
  span: number;
  /** Pixels of scroll travel. */
  max: number;
  visible: boolean;
}

const HIDDEN: Geometry = { top: 0, height: 0, span: 0, max: 0, visible: false };

function same(a: Geometry, b: Geometry): boolean {
  return (
    a.visible === b.visible &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.height) === Math.round(b.height) &&
    Math.round(a.span) === Math.round(b.span) &&
    Math.round(a.max) === Math.round(b.max)
  );
}

export interface ViewScrollbarProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * Any string that changes when the content's height might have. Scroll and
   * resize are observed directly; this covers the rest (view switch, group
   * collapse, density change) without a MutationObserver.
   */
  revision: string;
}

export const ViewScrollbar = memo(function ViewScrollbar({
  scrollRef,
  revision
}: ViewScrollbarProps) {
  const [geo, setGeo] = useState<Geometry>(HIDDEN);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  const frame = useRef(0);
  const drag = useRef<{ startY: number; startScroll: number; span: number; max: number } | null>(
    null
  );

  const measure = useCallback(() => {
    frame.current = 0;
    const el = scrollRef.current;
    if (!el) return;

    const max = el.scrollHeight - el.clientHeight;
    const box = el.getBoundingClientRect();

    // --- reads: which sticky headers are currently pinned, and how far down do
    // they reach?
    //
    // This used to test `offsetTop - scrollTop` against the CSS `top`, on the
    // theory that offsetTop is the un-stuck position. In Blink it is not:
    // offsetTop already INCLUDES the sticky shift, so for a pinned header that
    // expression equals `cssTop` exactly and the test rejected it. The only
    // moment it passed was the instant the next header was shoving this one out
    // — which is precisely the symptom reported (「只在被下一个标签顶替掉的
    // 一瞬间正确延伸了」).
    //
    // The rect says it plainly instead. A header is pinned when it has reached
    // its `top` line (relTop <= cssTop) and has not yet been pushed entirely
    // out of view.
    const stuck: Element[] = [];
    let stickyBottom = 0;
    if (max > 0) {
      // getComputedStyle is the expensive part, and every header of a kind
      // resolves to the same `top`. Keyed on the FIRST class only: the full
      // className is mutated below by `is-stuck`, so it made a useless cache.
      const topByClass = new Map<string, number>();
      for (const node of el.querySelectorAll<HTMLElement>(STICKY_SELECTOR)) {
        const kind = node.classList[0] ?? "";
        let cssTop = topByClass.get(kind);
        if (cssTop === undefined) {
          cssTop = parseFloat(getComputedStyle(node).top) || 0;
          topByClass.set(kind, cssTop);
        }
        const rect = node.getBoundingClientRect();
        const relTop = rect.top - box.top;
        if (relTop > cssTop + 0.5) continue; // still flowing, below its line
        if (relTop + rect.height <= 0.5) continue; // already pushed out of view
        stuck.push(node);
        stickyBottom = Math.max(stickyBottom, relTop + rect.height);
      }
    }

    const trackTop = Math.min(stickyBottom, el.clientHeight);
    const trackH = el.clientHeight - trackTop;
    const next: Geometry =
      max > 0 && trackH > MIN_THUMB
        ? (() => {
            const height = Math.min(
              trackH,
              Math.max(MIN_THUMB, (trackH * el.clientHeight) / el.scrollHeight)
            );
            const span = trackH - height;
            return {
              top: el.offsetTop + trackTop + (max > 0 ? (el.scrollTop / max) * span : 0),
              height,
              span,
              max,
              visible: true
            };
          })()
        : HIDDEN;

    // --- writes, all after the reads.
    for (const node of el.querySelectorAll(".is-stuck")) {
      if (!stuck.includes(node)) node.classList.remove("is-stuck");
    }
    for (const node of stuck) node.classList.add("is-stuck");
    if (!same(geoRef.current, next)) setGeo(next);
  }, [scrollRef]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [scrollRef, schedule]);

  // Content height can change with no scroll and no resize of the container
  // itself — a collapsed group, a switched view, a finished sync.
  useEffect(schedule, [revision, schedule]);

  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const el = scrollRef.current;
    if (!el || geo.span <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startY: e.clientY, startScroll: el.scrollTop, span: geo.span, max: geo.max };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    // A lost pointerup (released outside the window) would otherwise leave the
    // drag live — the same failure mode the marquee had.
    if ((e.buttons & 1) === 0) {
      drag.current = null;
      return;
    }
    el.scrollTop = d.startScroll + ((e.clientY - d.startY) / d.span) * d.max;
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // The thumb sits outside the scroll container, so a wheel over it would
  // otherwise do nothing.
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (el) el.scrollTop += e.deltaY;
  };

  if (!geo.visible) return null;
  return (
    <div
      className="vscroll-thumb"
      style={{ top: geo.top, height: geo.height }}
      aria-hidden="true"
      onPointerDown={onThumbDown}
      onPointerMove={onThumbMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onWheel={onWheel}
    />
  );
});
