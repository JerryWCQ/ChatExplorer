import { getMeta, setMeta } from "./db";
import { ICON_SIZE, META_KEY, type Density } from "./schema";

export type ThemePref = "system" | "light" | "dark";
export type LangPref = "auto" | "zh-CN" | "en";
/**
 * `reuseTab` is the fast path: instead of loading claude.ai again, it asks an
 * already-open claude.ai tab to switch conversations client-side. Falls back to
 * `focusExisting` behaviour when no such tab exists.
 */
export type OpenMode = "newTab" | "focusExisting" | "reuseTab";

export interface Settings {
  theme: ThemePref;
  language: LangPref;
  defaultIconSize: number;
  defaultDensity: Density;
  /** ms before a hover tooltip appears; 0 disables tooltips entirely. */
  hoverDelay: number;
  openMode: OpenMode;
  /**
   * Explorer's "item check boxes". Off by default because the modifier-key
   * gestures cover the same ground and the boxes cost a column; on, they make
   * multi-select possible without holding Ctrl.
   */
  showCheckboxes: boolean;
  previewPaneDefault: boolean;
  /** How many chats the "Recent" node lists. */
  recentCount: number;
  /** Minutes between automatic syncs; 0 disables. */
  autoSyncMinutes: number;
  /**
   * Shows the timings — "switched in 1043ms", "synced 1296 chats in 14s".
   *
   * Off by default (user decision): those numbers were written to prove the
   * sync and jump rewrites worked, and once they have, a toast on every single
   * open is noise. They stay reachable because the next time something is slow
   * they are the first thing worth looking at. Failures and fallbacks are never
   * gated behind this — a silent failure is the bug we just finished fixing.
   */
  debug: boolean;
  /**
   * Pane widths in px. Persisted rather than session-only because a pane width
   * is a workspace preference, not a reading posture: it should survive a
   * reload the way a window size does. Clamped on use, so a stale value from a
   * much wider screen cannot leave the content pane unusable.
   */
  navWidth: number;
  previewWidth: number;
  /** The AI organizer's panel, which takes the preview pane's place while open. */
  agentWidth: number;
}

/** Drag limits for the two side panes, in px. Preview's range is DESIGN 2.3. */
export const PANE_LIMITS = {
  nav: { min: 160, max: 420, default: 220 },
  preview: { min: 240, max: 480, default: 300 },
  // Wider than the preview: it holds a conversation, tool rows and a composer.
  agent: { min: 320, max: 720, default: 400 }
} as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "auto",
  defaultIconSize: ICON_SIZE.default,
  defaultDensity: "compact",
  hoverDelay: 3000,
  openMode: "newTab",
  showCheckboxes: false,
  previewPaneDefault: true,
  recentCount: 50,
  autoSyncMinutes: 0,
  debug: false,
  navWidth: PANE_LIMITS.nav.default,
  previewWidth: PANE_LIMITS.preview.default,
  agentWidth: PANE_LIMITS.agent.default
};

export async function loadSettings(): Promise<Settings> {
  const stored = await getMeta<Partial<Settings>>(META_KEY.settings);
  // Spread over the defaults so a settings key added in a later version does
  // not come back undefined for users who already have a stored object.
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await setMeta(META_KEY.settings, next);
  return next;
}
