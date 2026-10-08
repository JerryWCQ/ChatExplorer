/**
 * The "renamed locally" marker has two independent sources of truth — the
 * commit path in App, which stores null when the typed name matches the remote
 * one, and this predicate, which decides whether to draw the pencil. Data
 * written before the commit path normalised can still hold an alias equal to
 * the remote name, so the render side has to compare content rather than trust
 * that `displayName` being set means "edited".
 */

import { expect, test } from "vitest";
import type { Chat } from "../core/schema";
import { isRenamed } from "./format";

function chat(patch: Partial<Chat>): Chat {
  return {
    uuid: "u",
    remoteName: "Remote title",
    displayName: null,
    summary: "",
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    folderId: null,
    starred: false,
    flagged: false,
    hidden: false,
    notes: "",
    status: "present",
    ...patch
  } as Chat;
}

test("no alias is not a rename", () => {
  expect(isRenamed(chat({ displayName: null }))).toBe(false);
  expect(isRenamed(chat({ displayName: "" }))).toBe(false);
  expect(isRenamed(chat({ displayName: "   " }))).toBe(false);
});

test("an alias that differs from the claude.ai title is a rename", () => {
  expect(isRenamed(chat({ displayName: "My name" }))).toBe(true);
});

test("an alias equal to the claude.ai title is not a rename", () => {
  expect(isRenamed(chat({ displayName: "Remote title" }))).toBe(false);
  // Whitespace is not an edit either: both sides are trimmed before display.
  expect(isRenamed(chat({ displayName: "  Remote title  " }))).toBe(false);
  expect(isRenamed(chat({ remoteName: " Remote title ", displayName: "Remote title" }))).toBe(
    false
  );
});

test("case and inner spacing still count as a rename", () => {
  expect(isRenamed(chat({ displayName: "remote title" }))).toBe(true);
  expect(isRenamed(chat({ displayName: "Remote  title" }))).toBe(true);
});
