import type { Chat, Folder } from "../core/schema";

/**
 * Sample data for the showcase. Shapes are taken from the real index: long
 * Chinese titles, an empty title (11 of those exist), a chat with no summary
 * (48 of those), and duplicate names (44 pairs).
 */

function chat(over: Partial<Chat> & Pick<Chat, "uuid">): Chat {
  return {
    folderId: "unfiled",
    displayName: null,
    remoteName: "",
    summary: "",
    model: "claude-sonnet-4-5-20250929",
    createdAt: "2026-06-02T09:12:00Z",
    updatedAt: "2026-09-17T07:36:09Z",
    isStarred: false,
    isTemporary: false,
    projectUuid: null,
    lastReadAt: null,
    status: "active",
    firstSeenAt: 0,
    lastSyncedAt: 0,
    notes: "",
    flagged: false,
    hidden: false,
    pos: null,
    ...over
  };
}

const SUMMARY_ZH =
  "讨论了如何用 MV3 扩展在不注入页面的前提下读取会话列表，验证了 service worker 的 fetch 会自动带上会话 cookie，并据此把内容脚本和 CSP 绕过方案整个从设计里删掉。随后测量了全量拉取的成本：1296 条记录、3.78 MB、约 3 秒，结论是增量同步没有必要。";

const SUMMARY_EN =
  "Worked through whether an MV3 service worker can authenticate to claude.ai without a content script. Confirmed the session cookie rides along on fetch when host_permissions are declared, which removes the CSP workaround entirely. Then measured a full pull at 1296 records and about three seconds.";

export const SAMPLES: Chat[] = [
  chat({
    uuid: "a1",
    remoteName: "ChatExplorer 的同步层设计与 IndexedDB 取舍",
    summary: SUMMARY_ZH,
    model: "claude-opus-4-1-20250805",
    isStarred: true
  }),
  chat({
    uuid: "a2",
    remoteName: "Reworking the undo engine around inverse ops",
    summary: SUMMARY_EN,
    model: "claude-sonnet-4-5-20250929",
    flagged: true
  }),
  chat({
    uuid: "a3",
    remoteName: "SAT 数学错题整理",
    summary: "把最近三套卷子里做错的题按知识点归类，重点是数列和概率两块。",
    model: "claude-haiku-4-5-20260101",
    updatedAt: "2026-09-16T22:10:00Z"
  }),
  chat({
    uuid: "a4",
    remoteName: "",
    summary: "先确认一下这个接口返回的字段有哪些，然后再决定要不要存。",
    model: "claude-3-5-sonnet-20241022",
    createdAt: "2025-11-03T14:20:00Z",
    updatedAt: "2025-11-03T14:52:00Z"
  }),
  chat({
    uuid: "a5",
    remoteName: "没有摘要的一个对话",
    summary: "",
    model: "claude-fable-5-20260101",
    updatedAt: "2026-09-15T11:00:00Z"
  }),
  chat({
    uuid: "a6",
    remoteName: "旧模型时期的会话",
    summary: "这条用的是早期的模型串，应该落到 other 配色。",
    model: "claude-2.1",
    status: "missing",
    updatedAt: "2025-02-11T08:00:00Z"
  })
];

export const FOLDERS: Folder[] = [
  { id: "root", parentId: null, name: "ChatExplorer", createdAt: 0, hidden: false, pos: null },
  { id: "unfiled", parentId: "root", name: "Unfiled", createdAt: 0, hidden: false, pos: null },
  { id: "study", parentId: "root", name: "学习", createdAt: 0, hidden: false, pos: null },
  { id: "sat", parentId: "study", name: "SAT", createdAt: 0, hidden: false, pos: null },
  { id: "work", parentId: "root", name: "Work", createdAt: 0, hidden: false, pos: null }
];

export const MODEL_STRINGS = [
  "claude-fable-5-20260101",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20260101",
  "claude-2.1"
];
