/**
 * Contrast guard for the model tags.
 *
 * The tag is the one place in the UI where coloured text sits on a coloured
 * chip, and it is small text in both sizings — 11px in the fixed case, and
 * roughly 8px when it scales with a 64px icon. So WCAG AA's small-text
 * threshold of 4.5:1 applies, not the 3:1 allowed for large text.
 *
 * The values in DESIGN.md's first draft failed this on all ten pairs, which is
 * easy to do by eye: these are low-saturation colours chosen to sit calmly on
 * warm paper, and "calm" and "legible" pull in opposite directions. Reading the
 * numbers out of tokens.css rather than restating them here means the test
 * fails if someone retunes the palette by eye again.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SERIES = ["fable", "opus", "sonnet", "haiku", "other"] as const;
const THEMES = ["light", "dark"] as const;
const AA_SMALL_TEXT = 4.5;

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

/** Pulls one theme's block out of the stylesheet so the two cannot be confused. */
function themeBlock(theme: string): string {
  const start = css.indexOf(`[data-theme="${theme}"]`);
  expect(start, `no [data-theme="${theme}"] block`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

function tokenValue(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  expect(match, `--${name} missing or not a 6-digit hex`).not.toBeNull();
  return match![1]!;
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test.each(THEMES)("%s model tags meet WCAG AA for small text", (theme) => {
  const block = themeBlock(theme);
  const failures: string[] = [];

  for (const series of SERIES) {
    const fg = tokenValue(block, `model-${series}-fg`);
    const bg = tokenValue(block, `model-${series}-bg`);
    const ratio = contrast(fg, bg);
    if (ratio < AA_SMALL_TEXT) {
      failures.push(`${series}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
    }
  }

  expect(failures, `below ${AA_SMALL_TEXT}:1 —\n  ${failures.join("\n  ")}`).toEqual([]);
});

/**
 * The Delete button is white text on --danger-solid. The obvious shortcut is to
 * fill it with --danger, but that is a *foreground* colour and the dark theme's
 * value only reaches 2.9:1 under white — hence the separate token, and hence
 * this guard against someone collapsing the two back together.
 */
test.each(THEMES)("%s destructive button fill carries white text", (theme) => {
  const block = themeBlock(theme);
  for (const name of ["danger-solid", "danger-solid-hover"]) {
    const fill = tokenValue(block, name);
    expect(contrast("#ffffff", fill), `--${name} (${fill}) under #fff`).toBeGreaterThanOrEqual(
      AA_SMALL_TEXT
    );
  }
});

test("the sanity checks themselves are calibrated", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  // Order must not matter.
  expect(contrast("#974825", "#ebd7cb")).toBeCloseTo(contrast("#ebd7cb", "#974825"), 10);
});
