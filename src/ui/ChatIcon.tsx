import { modelInfo, type ModelSeries } from "../core/model";
import { Icon, SolidIcon } from "./Icon";
import { plainText } from "./markdown";

/**
 * The paper icon from DESIGN 3 — the one piece of visual identity in the whole
 * app, so it is worth building precisely.
 *
 * Structure is a vector layer (paper, folded corner, model stripe) with a DOM
 * layer on top (summary texture, model tag, badges). Text stays in the DOM
 * rather than the SVG so the browser handles wrapping and clamping, which is
 * both crisper and cheaper than measuring and laying out glyphs ourselves.
 */

const FOLD_RATIO = 0.22;
const BAR_HEIGHT = 3;

/**
 * Thumbnail tiers, per user feedback 2026-09-17: the unreadable "texture"
 * tier is gone. Either the text is big enough to read (>= 90px, at least the
 * font size a 160px icon gets) or the paper shows ruled lines.
 */
export type Tier = "lines" | "readable";

export function tierFor(size: number): Tier {
  return size < 90 ? "lines" : "readable";
}

/** 6.2% of the icon, floored at what the formula yields for a 160px icon. */
export function summaryFontSize(size: number): number {
  return Math.max(10, Math.round(size * 0.062));
}

/**
 * 12% of the icon, floored at 9px. Straight 12% keeps scaling down past the
 * point where the text is text: a 48px icon would get a 6px tag, which is a
 * grey smudge, not a label.
 */
export function tagFontSize(size: number): number {
  return Math.max(9, Math.round(size * 0.12));
}

/**
 * Below this the tag is dropped and the bottom colour stripe carries the model
 * series alone.
 *
 * DESIGN 3.3 originally put the cutoff at 48px, but that predates the decision
 * that the tag scales with the icon and is never ellipsized. Measured against
 * the widest label ("Sonnet 4.5") at the 9px floor, the tag needs ~50px and a
 * 48px icon only has 40px of padded width — so 48 and 56 cannot honour "show
 * the full name" at a legible size. 64px is the first size where it fits, and
 * it is also the default icon size.
 */
const TAG_MIN_SIZE = 64;

export interface ChatIconProps {
  size: number;
  model: string | null;
  summary: string;
  /** DESIGN 3.5: 40% opacity, applied to the whole icon. */
  missing?: boolean;
  /** Server-side star, read-only. */
  starred?: boolean;
  /** Local mark, the writable counterpart to `starred`. */
  flagged?: boolean;
  isShortcut?: boolean;
}

function PaperShape({ size, series }: { size: number; series: ModelSeries }) {
  const f = size * FOLD_RATIO;
  const edge = 0.5;
  const max = size - 0.5;
  return (
    <svg
      className="paper-shape"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <path
        d={`M${edge},${edge} H${max - f} L${max},${f} V${max} H${edge} Z`}
        fill="var(--paper-fill)"
        stroke="var(--paper-stroke)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* The turned-back corner, drawn over the paper so its two edges read. */}
      <path
        d={`M${max - f},${edge} V${f} H${max} Z`}
        fill="var(--paper-fold)"
        stroke="var(--paper-stroke)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <rect
        x={edge}
        y={max - BAR_HEIGHT}
        width={size - 1}
        height={BAR_HEIGHT}
        fill={`var(--model-${series}-fg)`}
      />
    </svg>
  );
}

/** Placeholder ruled lines for the smallest tier, and for chats with no summary. */
function Ruled({ size, dashed }: { size: number; dashed: boolean }) {
  // Four to six strokes of alternating length, per DESIGN 3.2.
  const widths = dashed ? [70, 55, 62] : [92, 74, 88, 60, 81, 68];
  const count = dashed ? 3 : Math.max(4, Math.min(6, Math.round(size / 11)));
  return (
    <div className={dashed ? "paper-ruled is-dashed" : "paper-ruled"}>
      {widths.slice(0, count).map((w, i) => (
        <span key={i} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export function ChatIcon({
  size,
  model,
  summary,
  missing = false,
  starred = false,
  flagged = false,
  isShortcut = false
}: ChatIconProps) {
  const info = modelInfo(model);
  const tier = tierFor(size);
  const pad = Math.max(4, Math.round(size * 0.08));
  const showTag = size >= TAG_MIN_SIZE;

  // The summary arrives as Markdown. At this size the syntax characters are
  // pure cost — literal `**` around a heading that says the same thing for
  // every chat ate the whole first line (user report) — so the thumbnail shows
  // the words only, starting after the constant lead-in label.
  const preview = plainText(summary);

  const fontSize = summaryFontSize(size);
  const lineH = Math.round(fontSize * 1.45);

  // Marks scale with the icon but cap out: a 16px star on a 256px paper is a
  // mark, a 40px star would be a poster.
  const markSize = Math.min(16, Math.max(9, Math.round(size * 0.16)));
  const marksTop = size * FOLD_RATIO + 2;
  const markCount = (starred ? 1 : 0) + (flagged ? 1 : 0);
  const marksH = markCount * markSize + Math.max(0, markCount - 1) * 2;

  // Whole lines only. -webkit-line-clamp would need display:-webkit-box, which
  // ignores floats — and the fold-avoidance spacer below is a float — so the
  // clamp is an exact multiple of the line height instead: the overflow cut
  // can then only ever fall on a line boundary.
  const tagH = showTag ? tagFontSize(size) + 2 * Math.max(1, Math.round(size * 0.02)) + 4 : 0;
  const availH = size - pad - (BAR_HEIGHT + pad / 2) - tagH;
  const lines = Math.max(1, Math.floor(availH / lineH));

  // The float keeps the first lines clear of the folded corner, and — when
  // marks are shown — of the mark column too, per feedback: text must never
  // run under either.
  const spacerH = Math.max(
    2 * lineH,
    markCount > 0 ? marksTop + marksH + 4 - pad : 0
  );

  const badge = Math.max(9, Math.round(size * 0.16));

  return (
    <div
      className={`chat-icon${missing ? " is-missing" : ""}`}
      style={{ width: size, height: size }}
    >
      <PaperShape size={size} series={info.series} />

      <div
        className="paper-content"
        style={{
          // Longhand only: mixing `padding` with `paddingBottom` makes React warn
          // about shorthand/longhand conflicts on every rerender.
          paddingTop: pad,
          paddingRight: pad,
          paddingLeft: pad,
          paddingBottom: BAR_HEIGHT + pad / 2
        }}
      >
        {tier === "lines" || !preview ? (
          <Ruled size={size} dashed={!preview} />
        ) : (
          <p
            className="paper-summary"
            style={{
              fontSize,
              lineHeight: `${lineH}px`,
              maxHeight: lines * lineH
            }}
            // The summary is user data; emoji inside it render as-is (DESIGN 0.2).
          >
            <span
              className="fold-spacer"
              aria-hidden="true"
              style={{ width: size * FOLD_RATIO + 2, height: spacerH }}
            />
            {preview}
          </p>
        )}

        {showTag && (
          <div
            className="paper-footer"
            // The badge now sits in this corner, so the footer gives it room.
            // The tag is `flex: none` and never ellipsises, so without the
            // reservation a long label would simply slide under the badge.
            style={isShortcut ? { paddingRight: badge + 4 } : undefined}
          >
            <ModelTag info={info} iconSize={size} />
          </div>
        )}
      </div>

      {(starred || flagged) && (
        <div className="paper-marks" style={{ top: marksTop, right: 3 }}>
          {/* Star is the server's, bookmark is the local mark. Different shapes
              so the two never read as the same thing. Stacked vertically per
              feedback, so "both" never widens into the text. */}
          {starred && <SolidIcon name="star" size={markSize} className="mark-star" />}
          {flagged && <SolidIcon name="bookmark" size={markSize} className="mark-flag" />}
        </div>
      )}

      {/* The shortcut badge floats in the bottom-*right* corner at every size.
          〔修订 2026-09-19 第三批〕It used to sit bottom-left, directly on top of
          the model tag — the user's screenshot showed "Opus 5" rendering as
          "pus 5". Bottom-right is the only free corner: the fold is top-right
          of the *shape* but the marks column already owns the top-right inset,
          and the tag owns the bottom-left. Keeping the badge out of the footer
          flow is still what guarantees the tag never needs an ellipsis. */}
      {isShortcut && (
        <span
          className="shortcut-badge is-floating"
          style={{ width: badge + 2, height: badge + 2 }}
        >
          <Icon name="cornerUpRight" size={badge - 1} />
        </span>
      )}
    </div>
  );
}

/**
 * With `iconSize` the tag scales with its paper — font at 12% of the icon width
 * but never under 9px, padding in proportion — and always shows the full name
 * (feedback: an ellipsis in a two-word label is worse than no label). Without it
 * (details rows, preview pane, pickers) the stylesheet's fixed sizing applies.
 */
export function ModelTag({
  info,
  iconSize
}: {
  info: ReturnType<typeof modelInfo>;
  iconSize?: number;
}) {
  const scaled =
    iconSize === undefined
      ? undefined
      : {
          fontSize: tagFontSize(iconSize),
          lineHeight: 1.2,
          padding: `${Math.max(1, Math.round(iconSize * 0.02))}px ${Math.max(3, Math.round(iconSize * 0.05))}px`,
          borderRadius: Math.max(3, Math.round(iconSize * 0.04))
        };
  return (
    <span
      className="model-tag"
      style={{
        color: `var(--model-${info.series}-fg)`,
        background: `var(--model-${info.series}-bg)`,
        ...scaled
      }}
    >
      {info.label}
    </span>
  );
}

/**
 * DESIGN 3.6. The folder's front panel sits over up to three mini papers so a
 * folder tells you what kind of thing is inside before you open it.
 */
export function FolderIcon({
  size,
  peek = [],
  dropTarget = false,
  missing = false
}: {
  size: number;
  /** Model strings of the first few children, in the folder's current sort order. */
  peek?: (string | null)[];
  dropTarget?: boolean;
  missing?: boolean;
}) {
  const showPeek = size >= 48 && peek.length > 0;
  const papers = peek.slice(0, 3);
  const paperW = size * 0.3;
  const paperH = size * 0.34;

  return (
    <div
      className={`folder-icon${dropTarget ? " is-drop" : ""}${missing ? " is-missing" : ""}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
        {/* Back panel */}
        <path
          d="M6 26a4 4 0 0 1 4-4h26l8 9h40a4 4 0 0 1 4 4v45a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z"
          fill="var(--folder-fill)"
          stroke="var(--folder-stroke)"
          strokeWidth="1.5"
        />
      </svg>

      {showPeek && (
        <div className="folder-peek" style={{ bottom: size * 0.2 }}>
          {papers.map((m, i) => {
            const info = modelInfo(m);
            return (
              <span
                key={i}
                className="peek-paper"
                style={{
                  width: paperW,
                  height: paperH,
                  transform: `translateX(${(i - (papers.length - 1) / 2) * paperW * 0.75}px) rotate(${(i - 1) * 4}deg)`,
                  zIndex: 3 - i
                }}
              >
                <span
                  className="peek-bar"
                  style={{ background: `var(--model-${info.series}-fg)` }}
                />
              </span>
            );
          })}
        </div>
      )}

      <svg
        className="folder-front"
        width={size}
        height={size}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        {/* Front panel, drawn after the peeking papers so they tuck behind it. */}
        <path
          d="M6 40h88v40a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z"
          fill="var(--folder-fill)"
          stroke="var(--folder-stroke)"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}
