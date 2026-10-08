/**
 * The organizer's tools: four that read, one that writes.
 *
 * Reading is where the context problem lives (「几千个文件」). Every read tool
 * therefore pages, speaks in short handles (`ids.ts`) and prints one compact
 * line per chat instead of JSON — a JSON object per chat repeats every key name
 * on every row. The model chooses how much of each summary it wants: none
 * (title and date are often enough), the first paragraph (usually enough to
 * file a chat), or the whole thing for a handful of chats at a time.
 *
 * Writing is one tool, `apply_changes`, taking a *batch*. One call is one
 * step of the undo log and one node the user can rewind to (user decision:
 * 「agent 的某一批动作算一个，比如把几十个文件移动」). A batch can create
 * folders and move chats into them in the same call, so "make 报税 and file
 * these 30 there" is one undoable step instead of two.
 *
 * Everything in this file is pure: a snapshot in, text and ops out. Tool output
 * is English — it is read by the model, not the user; the user sees the
 * translated one-line `brief` and the `preview` lines instead.
 */

import { modelInfo } from "../core/model";
import type { ChatPatch, Op } from "../core/ops";
import {
  ROOT_ID,
  STACK_MIN_MEMBERS,
  SYSTEM_FOLDER_IDS,
  type Chat,
  type Folder,
  type Stack
} from "../core/schema";
import { uniqueName, type Snapshot } from "../core/store";
import { displayName, dayKey } from "../ui/format";
import type { Lang, T } from "../ui/i18n";
import { summaryHead } from "../ui/markdown";
import { folderDisplayName, normalizeForSearch } from "../app/model";
import { IdRegistry } from "./ids";
import { treeRoots, type Access } from "./scope";
import type { Line } from "./types";

// --- specs -------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema. Kept to the subset both wire formats accept. */
  parameters: Record<string, unknown>;
}

export const READ_TOOLS = ["get_overview", "list_chats", "search_chats", "read_chats"] as const;
export const WRITE_TOOL = "apply_changes";
/**
 * Adds a line to the user's standing preferences. Always asks the user, and is
 * not an undo step: it changes configuration, not the library, and is edited
 * or removed in Settings → 整理偏好.
 */
export const REMEMBER_TOOL = "remember_preference";

const LIST_MAX = 200;
/**
 * A titles-only page is about a tenth the size of one with summary openings,
 * so it may be much longer: a whole-library pass is then three calls instead
 * of seven, and the model is not tempted to sample scattered pages instead.
 */
const LIST_MAX_TITLES = 500;
const HEAD_MAX = 400;
const READ_MAX_IDS = 20;
const READ_MAX_CHARS = 6000;
/** Past this a single tool result is cut short; the model is told how to page on. */
const OUTPUT_CAP = 60_000;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_overview",
    description:
      "Start here. Returns what you are allowed to organize, counts by model and date, " +
      "and the folder tree with handles (f1, f2, …; the top folder is 'root') and chat counts.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "list_chats",
    description:
      "List chats one page at a time, one compact line each: handle | last updated | model | " +
      "folder | title [| summary opening]. Without `folder` it lists the chats you may change. " +
      "Use summary_chars to include the opening paragraph of each summary (about 150 is " +
      "usually enough to file a chat); leave it 0 when titles suffice. Page with offset.",
    parameters: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder handle, e.g. f3 or root. Optional." },
        recursive: { type: "boolean", description: "With folder: include subfolders. Default false." },
        offset: { type: "integer", description: "Default 0." },
        limit: {
          type: "integer",
          description: `Titles only: default 300, max ${LIST_MAX_TITLES}. With summary_chars: default 100, max ${LIST_MAX}.`
        },
        summary_chars: {
          type: "integer",
          description: `0 = no summary (default). Otherwise the summary's first paragraph, cut to this many characters (max ${HEAD_MAX}).`
        },
        sort: { type: "string", enum: ["newest", "oldest", "name"], description: "Default newest." }
      }
    }
  },
  {
    name: "search_chats",
    description:
      "Find chats whose title, summary or notes mention a term. Several alternatives go in one " +
      "query separated by | (e.g. \"股票|美股|trading\"); there are no other operators. English and " +
      "number terms match whole words only (\"SAT\" does not match \"satisfy\"); Chinese terms match " +
      "anywhere. Matches in titles are listed first. Same line format as list_chats.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "One term, or alternatives separated by |." },
        limit: { type: "integer", description: `Default 50, max ${LIST_MAX}.` },
        summary_chars: { type: "integer", description: "Default 120." }
      },
      required: ["query"]
    }
  },
  {
    name: "read_chats",
    description:
      `Full details of up to ${READ_MAX_IDS} chats: whole summary, notes, folder, dates. ` +
      "Use sparingly, for chats whose title and opening paragraph are not enough.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Chat handles, e.g. c12." },
        max_chars: { type: "integer", description: `Per summary. Default 2000, max ${READ_MAX_CHARS}.` }
      },
      required: ["ids"]
    }
  },
  {
    name: WRITE_TOOL,
    description:
      "Apply one batch of changes. The whole batch is ONE undo step the user can rewind, so " +
      "group what belongs together (e.g. create a folder and move its chats in the same call), " +
      "and keep unrelated work in separate calls. Actions run in order; later actions may use " +
      "a folder created earlier in the same batch through its `ref`. Invalid actions are " +
      "skipped and reported; the rest still apply.\n" +
      "Action types:\n" +
      "- create_folder: name, parent (folder handle or 'root'), ref (your label, e.g. 'new1')\n" +
      "- move_chats: ids (chat handles), to (folder handle or ref)\n" +
      "- move_folder: id (folder handle), to (folder handle or ref)\n" +
      "- rename: id (chat or folder handle), name (for a chat, empty name restores its claude.ai title)\n" +
      "- create_stack: ids (chat handles, all in one folder), name (optional; default is their date range)\n" +
      "- delete: ids (chat or folder handles). Moves them to the bin. ONLY when the user explicitly asked to delete them.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One short line saying what this batch does, in the user's language. Shown in the undo history."
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["create_folder", "move_chats", "move_folder", "rename", "create_stack", "delete"]
              },
              ids: { type: "array", items: { type: "string" } },
              id: { type: "string" },
              to: { type: "string" },
              parent: { type: "string" },
              name: { type: "string" },
              ref: { type: "string" }
            },
            required: ["type"]
          }
        }
      },
      required: ["summary", "actions"]
    }
  },
  {
    name: REMEMBER_TOOL,
    description:
      "Propose saving one lasting organizing preference the user just expressed or confirmed, so " +
      "future sessions follow it. The user must approve it before it is saved. Only for " +
      "preferences that should also hold next time — never for a one-off instruction, and never " +
      "for something already in the user's preferences.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "One short sentence in the user's language, e.g. 「文件夹按项目分，不按技术」."
        }
      },
      required: ["text"]
    }
  }
];

// --- environment --------------------------------------------------------------------

export interface ToolEnv {
  snap: Snapshot;
  access: Access;
  ids: IdRegistry;
  lang: Lang;
  t: T;
}

export interface ReadResult {
  output: string;
  brief: Line;
  /**
   * The result in one English line. When the conversation grows long, older
   * read results are replaced by this, so the model keeps knowing *that* it
   * read something without paying for *what* it read again.
   */
  digest: string;
}

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(min, Math.min(max, n));
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()))] : [];

/** Single-line, pipe-safe: a title with a newline or "|" would break the row format. */
const cell = (s: string) => s.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();

function folderMaps(folders: Folder[]) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string, Folder[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f);
    else children.set(f.parentId, [f]);
  }
  return { byId, children };
}

function pathLabel(env: ToolEnv, folderId: string): string {
  const { byId } = folderMaps(env.snap.folders);
  const parts: string[] = [];
  let node = byId.get(folderId);
  while (node) {
    parts.unshift(folderDisplayName(node, env.t));
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return parts.join(" / ");
}

function chatLine(env: ToolEnv, chat: Chat, headChars: number): string {
  const parts = [
    env.ids.chat(chat.uuid),
    dayKey(chat.updatedAt),
    modelInfo(chat.model).label,
    env.ids.folder(chat.folderId),
    cell(displayName(chat, env.lang, env.t))
  ];
  if (headChars > 0) parts.push(cell(summaryHead(chat.summary, headChars)) || "(no summary)");
  // In "only these chats" mode the rest of the library is visible but frozen;
  // marking those rows saves the model a failed write.
  if (env.access.mode === "chats" && !env.access.canWriteChat(chat)) parts.push("read-only");
  return parts.join(" | ");
}

/** Joins rows until the cap, returning how many made it. */
function capRows(rows: string[], budget: number): { text: string; used: number } {
  let size = 0;
  let used = 0;
  for (const row of rows) {
    if (size + row.length + 1 > budget && used > 0) break;
    size += row.length + 1;
    used++;
  }
  return { text: rows.slice(0, used).join("\n"), used };
}

function sortChats(chats: Chat[], sort: string, env: ToolEnv): Chat[] {
  const out = [...chats];
  if (sort === "oldest") out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  else if (sort === "name") {
    out.sort((a, b) =>
      displayName(a, env.lang, env.t).localeCompare(displayName(b, env.lang, env.t), env.lang)
    );
  } else out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

// --- read tools ----------------------------------------------------------------------

function getOverview(env: ToolEnv): ReadResult {
  const { snap, access } = env;
  const writable = snap.chats.filter((c) => access.canWriteChat(c));
  const readable = snap.chats.filter((c) => access.canReadChat(c));

  const scopeLine =
    access.mode === "all"
      ? `Scope: the whole library. You may read and change everything below.`
      : access.mode === "folders"
        ? `Scope: the folders ${access.roots.map((id) => `${env.ids.folder(id)} "${pathLabel(env, id)}"`).join(", ")} and everything inside them` +
          `${writable.some((c) => !access.canReadFolder(c.folderId)) ? ", plus some individually selected chats" : ""}. ` +
          `You may only read and change things inside this scope; every move must land inside it.`
        : `Scope: ${writable.length} selected chats. You may change only these; the rest of the ` +
          `library is shown read-only so you can see where things could go. You may move them ` +
          `into any folder and create new folders, but not rename, move or delete existing folders.`;

  const byModel = new Map<string, number>();
  let unsummarized = 0;
  let first = "";
  let last = "";
  for (const c of writable) {
    const label = modelInfo(c.model).label;
    byModel.set(label, (byModel.get(label) ?? 0) + 1);
    if (!c.summary.trim()) unsummarized++;
    if (!first || c.updatedAt < first) first = c.updatedAt;
    if (!last || c.updatedAt > last) last = c.updatedAt;
  }
  const models = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m} ×${n}`)
    .join(", ");

  // Tree with direct / total counts, over readable folders only.
  const { byId, children } = folderMaps(snap.folders);
  const direct = new Map<string, number>();
  for (const c of readable) direct.set(c.folderId, (direct.get(c.folderId) ?? 0) + 1);
  const total = new Map<string, number>();
  const sum = (id: string): number => {
    const hit = total.get(id);
    if (hit !== undefined) return hit;
    let n = direct.get(id) ?? 0;
    for (const child of children.get(id) ?? []) if (access.canReadFolder(child.id)) n += sum(child.id);
    total.set(id, n);
    return n;
  };
  const rows: string[] = [];
  const walk = (id: string, depth: number) => {
    const folder = byId.get(id);
    if (!folder || !access.canReadFolder(id)) return;
    const frozen = !access.canEditFolder(id) && id !== ROOT_ID ? " *" : "";
    rows.push(
      `${"  ".repeat(depth)}${env.ids.folder(id)} ${cell(folderDisplayName(folder, env.t))} (${direct.get(id) ?? 0} / ${sum(id)})${frozen}`
    );
    const kids = [...(children.get(id) ?? [])].sort((a, b) => a.name.localeCompare(b.name, env.lang));
    for (const kid of kids) walk(kid.id, depth + 1);
  };
  for (const root of treeRoots(access)) walk(root, 0);
  const tree = capRows(rows, OUTPUT_CAP / 2);

  const output = [
    scopeLine,
    `Chats you may change: ${writable.length}` +
      (writable.length ? ` (updated ${dayKey(first)} … ${dayKey(last)}; ${unsummarized} without a summary)` : ""),
    models ? `By model: ${models}` : "",
    "",
    `Folder tree — handle, name, (chats directly inside / including subfolders). "*" = you may not rename, move or delete it:`,
    tree.text,
    tree.used < rows.length ? `… ${rows.length - tree.used} more folders not shown.` : ""
  ]
    .filter((l, i) => l !== "" || i === 3)
    .join("\n");

  return {
    output,
    brief: { key: "aiBriefOverview", vars: { n: writable.length } },
    digest: `get_overview: ${writable.length} chats in scope, ${rows.length} folders`
  };
}

function listChats(env: ToolEnv, input: Record<string, unknown>): ReadResult {
  const { snap, access, ids } = env;
  const handle = str(input.folder);
  let pool: Chat[];
  let where = "";
  if (handle) {
    const folderId = ids.resolveFolder(handle);
    if (!folderId || !access.canReadFolder(folderId)) {
      return {
        output: `Error: folder "${handle}" does not exist or is outside your scope. Call get_overview for valid handles.`,
        brief: { key: "aiBriefError" },
        digest: `list_chats: error, bad folder "${handle}"`
      };
    }
    const recursive = input.recursive === true;
    const inFolder = new Set<string>([folderId]);
    if (recursive) {
      const { children } = folderMaps(snap.folders);
      const stack = [folderId];
      while (stack.length) {
        const id = stack.pop()!;
        for (const kid of children.get(id) ?? []) {
          if (!inFolder.has(kid.id)) {
            inFolder.add(kid.id);
            stack.push(kid.id);
          }
        }
      }
    }
    pool = snap.chats.filter((c) => inFolder.has(c.folderId) && access.canReadChat(c));
    where = ` in ${ids.folder(folderId)}${recursive ? " (with subfolders)" : ""}`;
  } else {
    pool = snap.chats.filter((c) => access.canWriteChat(c));
  }

  const sorted = sortChats(pool, str(input.sort), env);
  const offset = int(input.offset, 0, 0, Math.max(0, sorted.length));
  const head = int(input.summary_chars, 0, 0, HEAD_MAX);
  const limit = int(input.limit, head ? 100 : 300, 1, head ? LIST_MAX : LIST_MAX_TITLES);
  const page = sorted.slice(offset, offset + limit);
  const { text, used } = capRows(page.map((c) => chatLine(env, c, head)), OUTPUT_CAP);
  const end = offset + used;

  const header =
    sorted.length === 0
      ? `No chats${where}.`
      : `Chats${where}: ${offset + 1}–${end} of ${sorted.length}` +
        (end < sorted.length ? ` (next page: offset=${end})` : " (end)") +
        (used < page.length ? ` — cut short to stay within the size limit; use a smaller limit or summary_chars.` : "");
  const firstHandle = page[0] ? ids.chat(page[0].uuid) : "";
  const lastHandle = page[used - 1] ? ids.chat(page[used - 1]!.uuid) : "";
  return {
    output: `${header}\nhandle | updated | model | folder | title${head ? " | summary opening" : ""}\n${text}`,
    brief:
      sorted.length === 0
        ? { key: "aiBriefListEmpty" }
        : {
            key: head ? "aiBriefListHeads" : "aiBriefList",
            vars: { from: offset + 1, to: end, total: sorted.length, range: `${firstHandle}–${lastHandle}` }
          },
    digest:
      sorted.length === 0
        ? `list_chats${where}: none`
        : `list_chats${where}: ${firstHandle}–${lastHandle} (${offset + 1}–${end} of ${sorted.length})${head ? " with summary openings" : ""}`
  };
}

/**
 * `a|b|c` (or `a OR b`) → a predicate that is true when any term matches.
 *
 * ASCII terms match whole words. Short Latin tokens are exactly what people
 * search an AI chat library for — course codes, tickers, acronyms — and as
 * substrings they drown: in one real library "SAT" hit 1,325 of 1,365 chats
 * (satisfy, saturday…) and "AP" 1,066 (app, approach). CJK text has no spaces
 * to be a word boundary, so those terms still match anywhere.
 */
export function searchMatcher(query: string): (text: string) => boolean {
  const terms = query
    .split(/\s+OR\s+|\|/i)
    .map((t) => normalizeForSearch(t.trim()))
    .filter(Boolean);
  const tests = terms.map((term) => {
    if (/^[\x20-\x7e]+$/.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
      return (hay: string) => re.test(hay);
    }
    return (hay: string) => hay.includes(term);
  });
  return (text) => {
    const hay = normalizeForSearch(text);
    return tests.some((t) => t(hay));
  };
}

function searchChats(env: ToolEnv, input: Record<string, unknown>): ReadResult {
  const query = str(input.query);
  if (!query) {
    return { output: "Error: query is empty.", brief: { key: "aiBriefError" }, digest: "search_chats: error" };
  }
  const match = searchMatcher(query);
  const limit = int(input.limit, 50, 1, LIST_MAX);
  const head = int(input.summary_chars, 120, 0, HEAD_MAX);
  const inTitle: Chat[] = [];
  const inBody: Chat[] = [];
  for (const c of env.snap.chats) {
    if (!env.access.canReadChat(c)) continue;
    if (match(`${c.displayName ?? ""}\n${c.remoteName}`)) inTitle.push(c);
    else if (match(`${c.summary}\n${c.notes}`)) inBody.push(c);
  }
  const hits = [...inTitle, ...inBody];
  const sorted = [...sortChats(inTitle, "newest", env), ...sortChats(inBody, "newest", env)].slice(0, limit);
  const { text, used } = capRows(sorted.map((c) => chatLine(env, c, head)), OUTPUT_CAP);
  return {
    output:
      hits.length === 0
        ? `No chats match "${query}".`
        : `${hits.length} chats match "${query}" (${inTitle.length} in the title)${hits.length > used ? `; showing ${used}, title matches first` : ""}.\n${text}`,
    brief: { key: "aiBriefSearch", vars: { q: query, n: hits.length } },
    digest: `search_chats "${query}": ${hits.length} hits (${sorted
      .slice(0, used)
      .map((c) => env.ids.chat(c.uuid))
      .join(", ")})`
  };
}

function readChats(env: ToolEnv, input: Record<string, unknown>): ReadResult {
  const handles = strs(input.ids).slice(0, READ_MAX_IDS);
  const maxChars = int(input.max_chars, 2000, 200, READ_MAX_CHARS);
  const byUuid = new Map(env.snap.chats.map((c) => [c.uuid, c]));
  const blocks: string[] = [];
  let found = 0;
  for (const h of handles) {
    const uuid = env.ids.resolveChat(h);
    const chat = uuid ? byUuid.get(uuid) : undefined;
    if (!chat || !env.access.canReadChat(chat)) {
      blocks.push(`${h}: not found or outside your scope.`);
      continue;
    }
    found++;
    const name = displayName(chat, env.lang, env.t);
    const remote = chat.remoteName.trim();
    const lines = [
      `${env.ids.chat(chat.uuid)} "${cell(name)}"` +
        (remote && remote !== name ? ` (claude.ai title: "${cell(remote)}")` : ""),
      `  folder: ${env.ids.folder(chat.folderId)} ${pathLabel(env, chat.folderId)} | model: ${modelInfo(chat.model).label} | ` +
        `created ${dayKey(chat.createdAt)} | updated ${dayKey(chat.updatedAt)}` +
        (chat.flagged ? " | flagged" : "") +
        (chat.isStarred ? " | starred" : "") +
        (env.access.mode === "chats" && !env.access.canWriteChat(chat) ? " | read-only" : "")
    ];
    if (chat.notes.trim()) lines.push(`  notes: ${cell(chat.notes)}`);
    const summary = chat.summary.trim();
    lines.push(
      summary
        ? `  summary:\n${summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary}`
        : "  summary: (none)"
    );
    blocks.push(lines.join("\n"));
  }
  const { text } = capRows(blocks, OUTPUT_CAP);
  return {
    output: handles.length === 0 ? "Error: no ids given." : text,
    brief: { key: "aiBriefRead", vars: { n: found } },
    digest: `read_chats: ${handles.join(", ")}`
  };
}

export function runReadTool(name: string, input: Record<string, unknown>, env: ToolEnv): ReadResult {
  switch (name) {
    case "get_overview":
      return getOverview(env);
    case "list_chats":
      return listChats(env, input);
    case "search_chats":
      return searchChats(env, input);
    case "read_chats":
      return readChats(env, input);
    default:
      return {
        output: `Error: unknown tool "${name}". Available: ${[...READ_TOOLS, WRITE_TOOL].join(", ")}.`,
        brief: { key: "aiBriefUnknownTool", vars: { name } },
        digest: `unknown tool ${name}`
      };
  }
}

// --- the write tool --------------------------------------------------------------------

export interface Plan {
  ops: Op[];
  /** One UI line per accepted change. */
  preview: Line[];
  /** One UI line per refused action. */
  errors: Line[];
  /** The same refusals, for the model. */
  modelErrors: string[];
  /** Folders this batch creates, in order — handles are minted after commit. */
  created: { id: string; name: string; ref: string }[];
  /** Any delete in the batch — such a batch always waits for the user. */
  hasDelete: boolean;
  /** Item keys the batch changes, for the grid's brief highlight. */
  touched: string[];
  /** Short, user-supplied line for the undo history. */
  summary: string;
}

/**
 * Turn one `apply_changes` call into ops for a single `commit`.
 *
 * Runs against working copies so later actions see earlier ones — a chat moved
 * into a folder created two actions ago, a stack formed from chats this batch
 * just gathered. Permission, though, is judged against the *original* records:
 * scope is about which chats the user handed over, not where they sit halfway
 * through a batch.
 *
 * Refused actions are reported, never fatal. One hallucinated handle must not
 * throw away forty good moves.
 */
export function planChanges(input: Record<string, unknown>, env: ToolEnv): Plan {
  const { snap, access, ids } = env;
  const ops: Op[] = [];
  const preview: Line[] = [];
  const errors: Line[] = [];
  const modelErrors: string[] = [];
  const created: Plan["created"] = [];
  const touched = new Set<string>();
  let hasDelete = false;

  const origChats = new Map(snap.chats.map((c) => [c.uuid, c]));
  const chats = new Map(origChats);
  const folders = new Map(snap.folders.map((f) => [f.id, f]));
  const stacks = new Map<string, Stack>(snap.stacks.map((s) => [s.id, s]));
  const refs = new Map<string, string>();
  const fresh = new Set<string>();

  const fail = (n: number, key: Line["key"], text: string, vars: Record<string, string | number> = {}) => {
    errors.push({ key, vars: { n, ...vars } });
    modelErrors.push(`action ${n}: ${text}`);
  };
  const folderName = (id: string) => {
    const f = folders.get(id);
    return f ? folderDisplayName(f, env.t) : "?";
  };
  const resolveFolderRef = (raw: string): string | null => {
    if (!raw) return null;
    const viaRef = refs.get(raw);
    if (viaRef) return viaRef;
    const id = ids.resolveFolder(raw);
    return id && folders.has(id) ? id : null;
  };
  const mayReceive = (id: string) => fresh.has(id) || access.canMoveInto(id);
  const mayEdit = (id: string) => fresh.has(id) || access.canEditFolder(id);
  const isSystem = (id: string) => SYSTEM_FOLDER_IDS.includes(id);
  const patchChat = (chat: Chat, patch: ChatPatch) => {
    chats.set(chat.uuid, { ...chat, ...patch });
    ops.push({ t: "chat.patch", uuid: chat.uuid, patch });
    touched.add(`chat:${chat.uuid}`);
  };
  /** Handles → current (working-copy) chats the scope lets us change. */
  const pickChats = (n: number, raw: unknown): Chat[] => {
    const out: Chat[] = [];
    const denied: string[] = [];
    for (const h of strs(raw)) {
      const uuid = ids.resolveChat(h);
      const orig = uuid ? origChats.get(uuid) : undefined;
      if (!orig || !access.canWriteChat(orig)) denied.push(h);
      else out.push(chats.get(orig.uuid)!);
    }
    if (denied.length > 0) {
      fail(
        n,
        "aiErrChats",
        `${denied.join(", ")} not found or outside your scope — skipped.`,
        { count: denied.length }
      );
    }
    return out;
  };

  const summary = str(input.summary).slice(0, 80);
  const actions = Array.isArray(input.actions) ? input.actions : [];
  if (actions.length === 0) modelErrors.push("no actions given.");

  actions.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(n, "aiErrAction", "not an object.");
      return;
    }
    const a = raw as Record<string, unknown>;
    switch (a.type) {
      case "create_folder": {
        const name = str(a.name);
        const parent = resolveFolderRef(str(a.parent) || "root");
        if (!name) return fail(n, "aiErrAction", "create_folder needs a name.");
        if (!parent || !(fresh.has(parent) || access.canCreateIn(parent))) {
          return fail(n, "aiErrFolder", `parent "${str(a.parent)}" not found or outside your scope.`);
        }
        const siblings = [...folders.values()].filter((f) => f.parentId === parent);
        const folder: Folder = {
          id: crypto.randomUUID(),
          parentId: parent,
          name: uniqueName(siblings, name),
          createdAt: Date.now(),
          hidden: false,
          pos: null
        };
        folders.set(folder.id, folder);
        fresh.add(folder.id);
        const ref = str(a.ref) || `new${n}`;
        refs.set(ref, folder.id);
        created.push({ id: folder.id, name: folder.name, ref });
        ops.push({ t: "folder.put", folder });
        touched.add(`folder:${folder.id}`);
        preview.push({ key: "aiPvCreateFolder", vars: { name: folder.name, parent: folderName(parent) } });
        return;
      }

      case "move_chats": {
        const to = resolveFolderRef(str(a.to));
        if (!to || !mayReceive(to)) {
          return fail(n, "aiErrFolder", `destination "${str(a.to)}" not found or outside your scope.`);
        }
        const moving = pickChats(n, a.ids).filter((c) => c.folderId !== to);
        if (moving.length === 0) return;
        for (const chat of moving) patchChat(chat, { folderId: to });
        preview.push({ key: "aiPvMove", vars: { n: moving.length, to: folderName(to) } });
        return;
      }

      case "move_folder": {
        const id = resolveFolderRef(str(a.id));
        const to = resolveFolderRef(str(a.to));
        if (!id || isSystem(id) || !mayEdit(id)) {
          return fail(n, "aiErrFolder", `folder "${str(a.id)}" cannot be moved (not found, a system folder, or outside your scope).`);
        }
        if (!to || !mayReceive(to)) {
          return fail(n, "aiErrFolder", `destination "${str(a.to)}" not found or outside your scope.`);
        }
        // A folder cannot move into itself or anything beneath it.
        for (let node: Folder | undefined = folders.get(to); node; node = node.parentId ? folders.get(node.parentId) : undefined) {
          if (node.id === id) return fail(n, "aiErrCycle", "a folder cannot move into its own subfolder.");
        }
        const folder = folders.get(id)!;
        if (folder.parentId === to) return;
        const siblings = [...folders.values()].filter((f) => f.parentId === to && f.id !== id);
        const next = { ...folder, parentId: to, name: uniqueName(siblings, folder.name) };
        folders.set(id, next);
        ops.push({ t: "folder.put", folder: next });
        touched.add(`folder:${id}`);
        preview.push({ key: "aiPvMoveFolder", vars: { name: folder.name, to: folderName(to) } });
        return;
      }

      case "rename": {
        const handle = str(a.id);
        const name = typeof a.name === "string" ? a.name.trim() : null;
        if (name === null) return fail(n, "aiErrAction", "rename needs a name.");
        if (IdRegistry.kindOf(handle) === "chat") {
          const [chat] = pickChats(n, [handle]);
          if (!chat) return;
          // Same rule as the rename box: the claude.ai title typed back, or
          // nothing at all, clears the alias instead of storing a copy of it.
          const next = !name || name === chat.remoteName.trim() ? null : name;
          if ((chat.displayName ?? null) === next) return;
          const from = displayName(chat, env.lang, env.t);
          patchChat(chat, { displayName: next });
          preview.push(
            next === null
              ? { key: "aiPvResetName", vars: { name: chat.remoteName.trim() || from } }
              : { key: "aiPvRenameChat", vars: { from, to: next } }
          );
          return;
        }
        const id = resolveFolderRef(handle);
        if (!id || isSystem(id) || !mayEdit(id)) {
          return fail(n, "aiErrFolder", `"${handle}" cannot be renamed (not found, a system folder, or outside your scope).`);
        }
        if (!name) return fail(n, "aiErrAction", "a folder name cannot be empty.");
        const folder = folders.get(id)!;
        if (folder.name === name) return;
        const next = { ...folder, name };
        folders.set(id, next);
        ops.push({ t: "folder.put", folder: next });
        touched.add(`folder:${id}`);
        preview.push({ key: "aiPvRenameFolder", vars: { from: folder.name, to: name } });
        return;
      }

      case "create_stack": {
        const members = pickChats(n, a.ids);
        const home = members[0]?.folderId;
        if (!home || members.length < STACK_MIN_MEMBERS || members.some((c) => c.folderId !== home)) {
          return fail(
            n,
            "aiErrStack",
            `a stack needs at least ${STACK_MIN_MEMBERS} of your chats, all in the same folder (move them first, in this batch if you like).`
          );
        }
        const keys = members.map((c) => `chat:${c.uuid}`);
        const taken = new Set(keys);
        // A chat sits in one pile at a time, so joining this one leaves any other.
        for (const stack of [...stacks.values()]) {
          if (stack.folderId !== home) continue;
          const kept = stack.members.filter((k) => !taken.has(k));
          if (kept.length === stack.members.length) continue;
          if (kept.length < STACK_MIN_MEMBERS) {
            stacks.delete(stack.id);
            ops.push({ t: "stack.del", id: stack.id });
          } else {
            const next = { ...stack, members: kept };
            stacks.set(stack.id, next);
            ops.push({ t: "stack.put", stack: next });
          }
        }
        const stack: Stack = {
          id: crypto.randomUUID(),
          folderId: home,
          name: str(a.name) || null,
          members: keys,
          createdAt: Date.now(),
          pos: null
        };
        stacks.set(stack.id, stack);
        ops.push({ t: "stack.put", stack });
        for (const k of keys) touched.add(k);
        preview.push({ key: "aiPvStack", vars: { n: keys.length, name: folderName(home) } });
        return;
      }

      case "delete": {
        const handles = strs(a.ids);
        const chatHandles = handles.filter((h) => IdRegistry.kindOf(h) === "chat");
        const folderHandles = handles.filter((h) => IdRegistry.kindOf(h) !== "chat");
        const doomed = pickChats(n, chatHandles);
        for (const chat of doomed) patchChat(chat, { hidden: true });
        if (doomed.length > 0) {
          hasDelete = true;
          preview.push({ key: "aiPvDeleteChats", vars: { n: doomed.length } });
        }
        for (const h of folderHandles) {
          const id = resolveFolderRef(h);
          if (!id || isSystem(id) || !mayEdit(id)) {
            fail(n, "aiErrFolder", `folder "${h}" cannot be deleted (not found, a system folder, or outside your scope).`);
            continue;
          }
          const folder = folders.get(id)!;
          const next = { ...folder, hidden: true };
          folders.set(id, next);
          ops.push({ t: "folder.put", folder: next });
          touched.add(`folder:${id}`);
          hasDelete = true;
          preview.push({ key: "aiPvDeleteFolder", vars: { name: folder.name } });
        }
        return;
      }

      default:
        fail(n, "aiErrAction", `unknown action type "${String(a.type)}".`);
    }
  });

  return { ops, preview, errors, modelErrors, created, hasDelete, touched: [...touched], summary };
}

/**
 * What the model hears back after a batch: what happened, the handles of the
 * folders it just created (it will want to use them), and what was refused.
 */
export function describeOutcome(plan: Plan, ids: IdRegistry, applied: boolean): string {
  const lines: string[] = [];
  if (!applied) {
    lines.push("Not applied — the user rejected this batch. Ask them what they want instead.");
  } else if (plan.ops.length === 0) {
    lines.push("Nothing changed — every action was refused or already true.");
  } else {
    lines.push(`Applied as one undo step: ${plan.preview.length} change(s).`);
    for (const c of plan.created) lines.push(`Created folder ${ids.folder(c.id)} "${c.name}" (ref ${c.ref}).`);
  }
  if (plan.modelErrors.length > 0) {
    lines.push("Refused:");
    for (const e of plan.modelErrors) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}
