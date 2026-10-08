import { expect, test } from "vitest";
import { compareModel, modelInfo } from "./model";

test("the modern series-first naming is parsed", () => {
  expect(modelInfo("claude-sonnet-4-5-20250929")).toMatchObject({
    series: "sonnet",
    label: "Sonnet 4.5",
    order: 4.5
  });
  expect(modelInfo("claude-opus-4-1-20250805").label).toBe("Opus 4.1");
  expect(modelInfo("claude-fable-5-20260101").label).toBe("Fable 5");
});

test("the older version-first naming is parsed too", () => {
  expect(modelInfo("claude-3-5-sonnet-20241022")).toMatchObject({
    series: "sonnet",
    label: "Sonnet 3.5"
  });
  expect(modelInfo("claude-3-opus-20240229").label).toBe("Opus 3");
  expect(modelInfo("claude-3-5-haiku-latest").label).toBe("Haiku 3.5");
});

test("an unknown model degrades to a readable label rather than a guess", () => {
  const info = modelInfo("claude-2.1");
  expect(info.series).toBe("other");
  expect(info.label).toBe("2.1");

  expect(modelInfo("some-future-thing-20270101").series).toBe("other");
  expect(modelInfo(null).label).toBe("—");
  expect(modelInfo("").label).toBe("—");
});

test("sorting ranks by series first and version second", () => {
  const sorted = [
    "claude-haiku-4-5-20260101",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1-20250805",
    "claude-2.1",
    "claude-fable-5-20260101",
    "claude-opus-4-5-20260101",
    "claude-3-5-sonnet-20241022"
  ].sort(compareModel);

  // Haiku 4.5 sits below Sonnet 3.5: a bigger version number does not make a
  // smaller model bigger. Unrecognised strings gather at the bottom.
  expect(sorted.map((m) => modelInfo(m).label)).toEqual([
    "2.1",
    "Haiku 4.5",
    "Sonnet 3.5",
    "Sonnet 4.5",
    "Opus 4.1",
    "Opus 4.5",
    "Fable 5"
  ]);
});
