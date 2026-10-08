/**
 * Maps raw `model` strings from the API onto a display label and a colour
 * series. Kept in one file on purpose (DESIGN 3.3) so a new model release is a
 * one-line change here rather than a hunt through the UI.
 */

export type ModelSeries = "fable" | "opus" | "sonnet" | "haiku" | "other";

/**
 * How big a model is, in the only sense users care about: haiku < sonnet <
 * opus < fable. Unrecognised strings rank below everything, so they gather at
 * one end instead of interleaving with real models.
 */
export const SERIES_RANK: Record<ModelSeries, number> = {
  other: 0,
  haiku: 1,
  sonnet: 2,
  opus: 3,
  fable: 4
};

const KNOWN: Record<string, ModelSeries> = {
  fable: "fable",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku"
};

export interface ModelInfo {
  series: ModelSeries;
  /** e.g. "4.5", or "" when the string carries no version. */
  version: string;
  /** e.g. "Sonnet 4.5". Never empty. */
  label: string;
  /** Numeric form of `version` for sorting; 0 when unknown. */
  order: number;
}

const UNKNOWN: ModelInfo = { series: "other", version: "", label: "—", order: 0 };

const cache = new Map<string, ModelInfo>();

/**
 * Handles both the modern `claude-<series>-<major>-<minor>-<date>` shape and
 * the older `claude-<major>-<minor>-<series>-<date>` one, since the account
 * has conversations spanning both eras.
 */
function parse(raw: string): ModelInfo {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return UNKNOWN;

  const tokens = trimmed
    .replace(/^claude[-_]?/, "")
    .split(/[-_]/)
    .filter((tok) => tok && !/^\d{8}$/.test(tok) && tok !== "latest" && tok !== "v1");

  let series: ModelSeries = "other";
  const numbers: string[] = [];
  for (const tok of tokens) {
    const known = KNOWN[tok];
    if (known) series = known;
    else if (/^\d+(\.\d+)?$/.test(tok)) numbers.push(tok);
  }

  // "4" + "5" is the dotted form split across tokens; "2.1" arrives whole.
  const version = numbers.length > 1 ? `${numbers[0]}.${numbers[1]}` : (numbers[0] ?? "");
  const order = version ? Number(version) : 0;

  if (series === "other") {
    // Unrecognised: show something short and truthful rather than guessing.
    const label = raw.replace(/^claude[-_]?/i, "").replace(/-\d{8}$/, "") || raw;
    return { series, version, label, order };
  }

  const name = series.charAt(0).toUpperCase() + series.slice(1);
  return { series, version, label: version ? `${name} ${version}` : name, order };
}

export function modelInfo(raw: string | null | undefined): ModelInfo {
  if (!raw) return UNKNOWN;
  let hit = cache.get(raw);
  if (!hit) {
    hit = parse(raw);
    cache.set(raw, hit);
  }
  return hit;
}

/**
 * Ascending model sort: **series first, version second** — the user's
 * 「先按模型大小，再按数字大小」. So Haiku 4.5 still sorts below Sonnet 3.5,
 * because a bigger number does not make a smaller model bigger.
 *
 * 〔修订 2026-09-19 第三批〕This used to return the *descending* order, which
 * every caller then had to negate. Same ordering, but the double negative made
 * the direction hard to reason about, and the label tiebreak was left running
 * backwards because of it. Ascending is now the plain meaning of the name.
 */
export function compareModel(a: string | null, b: string | null): number {
  const x = modelInfo(a);
  const y = modelInfo(b);
  const rank = SERIES_RANK[x.series] - SERIES_RANK[y.series];
  return rank !== 0 ? rank : x.order - y.order || x.label.localeCompare(y.label);
}
