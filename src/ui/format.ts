import type { Chat } from "../core/schema";
import type { Lang, T } from "./i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function clockTime(d: Date, lang: Lang): string {
  return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", hour12: lang === "en" });
}

/**
 * DESIGN 8.6: relative inside three days, absolute beyond it. "Yesterday" is
 * calendar-based rather than 24-hour-based, which is what people actually mean.
 */
export function formatDate(iso: string, lang: Lang, t: T, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const delta = now - d.getTime();

  if (delta >= 0 && delta < 3 * DAY) {
    if (delta < MINUTE) return t("justNow");
    if (delta < HOUR) return t("minutesAgo", { n: Math.floor(delta / MINUTE) });

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const daysBack = Math.floor((startOfToday.getTime() - d.getTime()) / DAY) + 1;

    if (d.getTime() >= startOfToday.getTime()) {
      return t("hoursAgo", { n: Math.floor(delta / HOUR) });
    }
    if (daysBack === 1) return t("yesterdayAt", { time: clockTime(d, lang) });
    if (daysBack <= 3) return t("daysAgo", { n: daysBack });
  }

  return lang === "zh-CN"
    ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${clockTime(d, "zh-CN")}`
    : `${d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })} ${clockTime(d, "en")}`;
}

/** Group header for "group by month" (DESIGN 5.2). */
export function monthLabel(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return lang === "zh-CN"
    ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
    : d.toLocaleDateString("en", { month: "long", year: "numeric" });
}

/**
 * Local calendar day as "YYYY-MM-DD". The partition key for 「自动按日折叠」.
 *
 * Deliberately not `iso.slice(0, 10)`: the stored timestamps are UTC, and in
 * UTC+8 everything after 08:00 local would fall on the wrong side of midnight.
 * A day has to mean the user's day or the piles look shuffled.
 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Bare day, no clock: "9月18日" / "Sep 18". The year shows only when it differs. */
function bareDay(d: Date, lang: Lang, withYear: boolean): string {
  if (lang === "zh-CN") {
    return withYear
      ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
      : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }
  return d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {})
  });
}

/**
 * The name a stack gives itself when the user has not typed one — the user's
 * 「叠放后的名称可以是时间段」.
 *
 * One day collapses to that day, and the two days everybody actually recognises
 * get words instead of numbers. A range keeps both ends; the year appears only
 * on the end that needs it, so "12 月 30 日 – 2026 年 1 月 2 日" stays readable
 * while a same-year range stays short.
 */
export function rangeLabel(fromIso: string, toIso: string, lang: Lang, t: T, now = Date.now()): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const thisYear = new Date(now).getFullYear();

  if (dayKey(fromIso) === dayKey(toIso)) {
    const today = new Date(now);
    if (dayKey(toIso) === dayKey(today.toISOString())) return t("dateToday");
    const yesterday = new Date(now - DAY);
    if (dayKey(toIso) === dayKey(yesterday.toISOString())) return t("dateYesterday");
    return bareDay(to, lang, to.getFullYear() !== thisYear);
  }
  return `${bareDay(from, lang, from.getFullYear() !== thisYear)} – ${bareDay(to, lang, to.getFullYear() !== thisYear)}`;
}

/** Cheap first-sentence extraction, used only as a title fallback. */
function firstSentence(summary: string): string {
  const text = summary.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const end = text.search(/[。！？.!?]/);
  const cut = end === -1 ? text : text.slice(0, end + 1);
  return cut.length > 60 ? `${cut.slice(0, 60)}…` : cut;
}

/**
 * Whether the "renamed locally" marker should show. A stored alias that happens
 * to equal the claude.ai title is not a rename — the user typed the name back,
 * so the displayed name matches the remote one and the pencil would be a lie.
 */
export function isRenamed(chat: Chat): boolean {
  const local = chat.displayName?.trim();
  if (!local) return false;
  return local !== chat.remoteName.trim();
}

/**
 * DESIGN 3.4 name resolution: local alias, then the claude.ai title, then the
 * first sentence of the summary, then a dated placeholder. A chat always has a
 * readable name, which matters because 11 of them have an empty title.
 */
export function displayName(chat: Chat, lang: Lang, t: T): string {
  const local = chat.displayName?.trim();
  if (local) return local;
  const remote = chat.remoteName.trim();
  if (remote) return remote;
  const sentence = firstSentence(chat.summary);
  if (sentence) return sentence;
  const created = new Date(chat.createdAt);
  const date = Number.isNaN(created.getTime())
    ? "?"
    : lang === "zh-CN"
      ? `${created.getFullYear()}/${created.getMonth() + 1}/${created.getDate()}`
      : created.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  return t("untitled", { date });
}
