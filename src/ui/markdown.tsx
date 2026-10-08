/**
 * A very small Markdown renderer, for one job: claude.ai writes conversation
 * summaries in Markdown, and we show them in two places that want opposite
 * things.
 *
 *   `plainText` — the icon thumbnail. There is room for a few dozen characters
 *   at 10px, so every `**` spent on syntax is a character not spent on content.
 *
 *   `<Markdown>` — the preview pane, which has the room to show the structure
 *   the summary was written with.
 *
 * Deliberately not a dependency and deliberately not complete. The input is one
 * known generator writing short prose with the occasional heading and bullet
 * list, not the open web, so the grammar below is the subset that actually
 * turns up. Output is React nodes, never `dangerouslySetInnerHTML`: the summary
 * is remote text, and the only way to be sure it cannot inject markup is never
 * to hand it to the HTML parser.
 */

import type { ReactNode } from "react";

/**
 * Summaries open with a bolded label — `**Conversation Overview**` — that says
 * the same thing for every chat. In a thumbnail that is the entire first line
 * wasted on a constant (user report). Dropped when it is short enough to be a
 * label rather than a sentence, and only at the very start.
 */
const LEAD_IN =
  /^\s*(?:#{1,6}\s*(?:\*\*|__)?[^\n*_]{1,40}(?:\*\*|__)?|(?:\*\*|__)[^\n*_]{1,40}(?:\*\*|__))\s*:?\s*/;

/**
 * Inline emphasis/code/strike/link, with their content captured.
 *
 * A factory rather than a constant: `inline` below recurses (bold inside a link
 * text, italic inside bold), and a shared `/g` regex carries `lastIndex` across
 * calls, so the inner scan would silently eat the outer one's position.
 */
const inlineRe = () =>
  /(`+)([^`]*?)\1|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5|(~~)(.+?)\7|\[(.*?)\]\((.*?)\)/g;

/** Strips inline syntax, keeping the words. */
function stripInline(line: string): string {
  return line.replace(inlineRe(), (_m, ...g: unknown[]) => {
    const parts = g as (string | undefined)[];
    // Groups run 2,4,6,8 for code/bold/italic/strike content; 9 is link text.
    return parts[1] ?? parts[3] ?? parts[5] ?? parts[7] ?? parts[8] ?? "";
  });
}

/**
 * Memoised because of where it is called from: one icon grid is on the order of
 * a thousand thumbnails, each running six regex passes over a summary that can
 * be a full paragraph, and the grid re-renders on every mutation. The input is
 * an immutable string straight out of the store, so the answer can never go
 * stale — only the cache can grow, hence the cap.
 */
const PLAIN_CACHE = new Map<string, string>();
const PLAIN_CACHE_MAX = 4000;

/**
 * Markdown reduced to the words. Used by the thumbnail, where the syntax
 * characters cost more than the structure is worth.
 */
export function plainText(md: string): string {
  const hit = PLAIN_CACHE.get(md);
  if (hit !== undefined) return hit;
  const out = computePlainText(md);
  // Cheapest eviction that cannot degenerate: past the cap, start over. The
  // working set is one folder's worth of summaries, so a full clear costs one
  // re-scan of what is on screen, not a scan per lookup.
  if (PLAIN_CACHE.size >= PLAIN_CACHE_MAX) PLAIN_CACHE.clear();
  PLAIN_CACHE.set(md, out);
  return out;
}

function computePlainText(md: string): string {
  const withoutLeadIn = md.replace(LEAD_IN, "");
  return stripInline(withoutLeadIn)
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+[.)]\s+/, "")
        .replace(/^\s*[-*_]{3,}\s*$/, "")
        .trim()
    )
    .filter((line) => line !== "")
    .join(" ")
    .trim();
}

/**
 * The first paragraph of a summary as plain text, cut to `maxChars` — the
 * AI organizer's cheap read (「把所有聊天数据加上简介的第一段读取」).
 *
 * claude.ai summaries open with an overview paragraph and then break into
 * labelled sections; the overview is nearly always enough to file a chat, and
 * it is a tenth of the whole. A paragraph ends at a blank line or at the first
 * heading / bold label / list item that follows some text.
 */
export function summaryHead(md: string, maxChars: number): string {
  const lines = md.replace(LEAD_IN, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === "";
    const opensSection = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|(\*\*|__)[^*_]{1,40}(\*\*|__)\s*:?\s*$)/.test(line);
    if (kept.length > 0 && (blank || opensSection)) break;
    if (!blank) kept.push(line);
  }
  // Not `plainText`: that strips the lead-in label a second time, and would eat
  // a bolded first word ("**Python** is …") now that the real label is gone.
  const text = stripInline(kept.join(" ")).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

// --- rendering ----------------------------------------------------------------

/** Only these schemes become real links; anything else stays text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = inlineRe();
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[4] !== undefined) out.push(<strong key={key}>{inline(m[4], key)}</strong>);
    else if (m[6] !== undefined) out.push(<em key={key}>{inline(m[6], key)}</em>);
    else if (m[8] !== undefined) out.push(<del key={key}>{inline(m[8], key)}</del>);
    else if (m[9] !== undefined) {
      const href = safeHref(m[10] ?? "");
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {m[9]}
          </a>
        ) : (
          m[9]
        )
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  /**
   * `start` is the number the source wrote on the first item. Models put a
   * blank line between numbered items, or a sub-bullet under one, and either
   * splits the list here; keeping the written number means the second piece
   * still reads "2." instead of starting over at "1." (user report).
   */
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "rule" };

/**
 * One pass, line by line. Lists and paragraphs accumulate until a line that
 * cannot belong to them; everything else is a single line.
 */
function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++) body.push(lines[i] ?? "");
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const rule = /^\s*([-*_])\s*(\1\s*){2,}$/.exec(line);
    if (rule) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const text = (bullet ? bullet[1] : numbered![2]) ?? "";
      if (para.length > 0) {
        blocks.push({ kind: "p", text: para.join(" ") });
        para = [];
      }
      if (list && list.ordered !== ordered) {
        blocks.push({ kind: "list", ...list });
        list = null;
      }
      list ??= { ordered, start: numbered ? Number(numbered[1]) || 1 : 1, items: [] };
      list.items.push(text);
      continue;
    }

    if (list && list.items.length > 0) {
      // A plain line right under a bullet is that bullet's continuation.
      const at = list.items.length - 1;
      list.items[at] = `${list.items[at] ?? ""} ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Renders Markdown as React nodes. `lead` drops the constant `**Conversation
 * Overview**` label the way the thumbnail does; the preview pane keeps it,
 * because there it is a heading with room to be one.
 */
export function Markdown({
  text,
  className,
  dropLeadIn = false
}: {
  text: string;
  className?: string;
  dropLeadIn?: boolean;
}) {
  const blocks = parse(dropLeadIn ? text.replace(LEAD_IN, "") : text);
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            // Summaries are a fragment inside our page, not a document, so the
            // markup level is pinned and only the size varies — otherwise a
            // summary starting at `###` would outrank the pane's own headings.
            const size = Math.min(b.level, 4);
            return (
              <p key={key} className={`md-h md-h${size}`}>
                {inline(b.text, key)}
              </p>
            );
          }
          case "p":
            return <p key={key}>{inline(b.text, key)}</p>;
          case "quote":
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key}>
                <code>{b.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={key} />;
          case "list":
            return b.ordered ? (
              <ol key={key} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
