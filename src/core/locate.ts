import { folderPath } from "./store";
import type { Chat, Folder, Shortcut } from "./schema";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepts a full claude.ai URL, a path, or a bare uuid. */
export function extractUuid(input: string): string | null {
  const match = UUID_RE.exec(input.trim());
  return match ? match[0].toLowerCase() : null;
}

export interface LocateResult {
  chat: Chat;
  /** Root-to-chat folder chain of its one true location. */
  path: Folder[];
  /** Every alias pointing at this chat, with its own folder chain. */
  shortcuts: { shortcut: Shortcut; path: Folder[] }[];
}

export function locate(
  input: string,
  data: { folders: Folder[]; chats: Chat[]; shortcuts: Shortcut[] }
): LocateResult | null {
  const uuid = extractUuid(input);
  if (!uuid) return null;
  const chat = data.chats.find((c) => c.uuid === uuid);
  if (!chat) return null;
  return {
    chat,
    path: folderPath(data.folders, chat.folderId),
    shortcuts: data.shortcuts
      .filter((s) => s.targetUuid === uuid)
      .map((shortcut) => ({ shortcut, path: folderPath(data.folders, shortcut.folderId) }))
  };
}
