import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Markdown, plainText } from "./markdown";

test("numbered items separated by blank lines or sub-bullets keep their numbers (user report)", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { text: "1. **Work** stuff\n\n2. Study\n   - AP\n   - SAT\n3. Personal" })
  );
  // Each split-off piece starts at the number the source wrote, not at 1.
  expect(html).toMatch(/<ol start="1"><li><strong>Work<\/strong> stuff<\/li><\/ol>/);
  expect(html).toMatch(/<ol start="2"><li>Study<\/li><\/ol>/);
  expect(html).toMatch(/<ol start="3"><li>Personal<\/li><\/ol>/);
});

/**
 * The shape claude.ai actually produces: a bolded label, then prose, then a
 * bulleted section. The thumbnail has room for a few dozen characters, so what
 * matters is that none of them are spent on syntax or on the constant label.
 */
const REAL = `**Conversation Overview** This conversation explores the boundary
behaviour of \`Math.random()\`.

**Key Points**
- The range is [0, 1)
- 1 is never returned`;

test("the constant lead-in label is dropped", () => {
  expect(plainText(REAL).startsWith("This conversation explores")).toBe(true);
});

test("no syntax characters survive into the thumbnail", () => {
  const out = plainText(REAL);
  expect(out).not.toMatch(/[*`#]/);
  expect(out).toContain("Math.random()");
  expect(out).toContain("The range is [0, 1)");
});

test("blank lines become single spaces, so the clamp counts real text", () => {
  expect(plainText("a\n\n\nb")).toBe("a b");
});

test("a heading lead-in is dropped the same way as a bold one", () => {
  expect(plainText("## Summary\nThe rest.")).toBe("The rest.");
});

test("a long opening sentence in bold is content, not a label, and stays", () => {
  const long = `**${"x".repeat(60)}** tail`;
  expect(plainText(long)).toContain("x".repeat(60));
});

test("prose with no markdown at all is returned unchanged", () => {
  expect(plainText("Just a sentence.")).toBe("Just a sentence.");
});

test("an empty or whitespace-only summary reads as empty, so the icon rules", () => {
  // ChatIcon switches to ruled lines on a falsy result; "**" alone must not
  // count as content.
  expect(plainText("   \n  ")).toBe("");
  expect(plainText("**")).toBe("**");
});

test("link text survives, the url does not", () => {
  expect(plainText("see [the docs](https://example.com) now")).toBe("see the docs now");
});
