/**
 * Short handles for the model: `c12` for a chat, `f3` for a folder.
 *
 * A UUID costs the model roughly 25 tokens every time it is read or written;
 * a library of 1300 chats read once spends ~30k tokens on identifiers alone,
 * and every move repeats them. A handle costs two or three. It also removes a
 * whole class of failure — models mistype 36-character hex strings, and a
 * mistyped UUID is a silent miss, while `c12` either exists or it does not.
 *
 * Handles are handed out lazily, in the order things are first shown, and the
 * registry is persisted with the session. It must be: the conversation history
 * keeps using the handles it has already seen, so they can never be reassigned,
 * and a chat that syncs in later simply gets the next number.
 */

import { ROOT_ID } from "../core/schema";

export class IdRegistry {
  private chats: string[];
  private folders: string[];
  private chatIndex = new Map<string, number>();
  private folderIndex = new Map<string, number>();

  constructor(saved?: { chats: string[]; folders: string[] }) {
    this.chats = [...(saved?.chats ?? [])];
    this.folders = [...(saved?.folders ?? [])];
    this.chats.forEach((uuid, i) => this.chatIndex.set(uuid, i));
    this.folders.forEach((id, i) => this.folderIndex.set(id, i));
  }

  chat(uuid: string): string {
    let i = this.chatIndex.get(uuid);
    if (i === undefined) {
      i = this.chats.push(uuid) - 1;
      this.chatIndex.set(uuid, i);
    }
    return `c${i + 1}`;
  }

  /** The root keeps its readable name; the model is told to write "root". */
  folder(id: string): string {
    if (id === ROOT_ID) return "root";
    let i = this.folderIndex.get(id);
    if (i === undefined) {
      i = this.folders.push(id) - 1;
      this.folderIndex.set(id, i);
    }
    return `f${i + 1}`;
  }

  /**
   * Handle → real id. Tolerant of the ways models actually write handles back:
   * surrounding whitespace, upper case, and — because the full UUID sometimes
   * leaks through from a folded result — the raw UUID itself.
   */
  resolveChat(handle: string): string | null {
    const h = handle.trim();
    const m = /^c(\d+)$/i.exec(h);
    if (m) return this.chats[Number(m[1]) - 1] ?? null;
    return this.chatIndex.has(h) ? h : null;
  }

  resolveFolder(handle: string): string | null {
    const h = handle.trim();
    if (h.toLowerCase() === "root" || h === "/") return ROOT_ID;
    const m = /^f(\d+)$/i.exec(h);
    if (m) return this.folders[Number(m[1]) - 1] ?? null;
    return this.folderIndex.has(h) ? h : null;
  }

  /** "c12" → "chat", "f3"/"root" → "folder", anything else → null. */
  static kindOf(handle: string): "chat" | "folder" | null {
    const h = handle.trim();
    if (/^c\d+$/i.test(h)) return "chat";
    if (/^f\d+$/i.test(h) || h.toLowerCase() === "root") return "folder";
    return null;
  }

  toJSON(): { chats: string[]; folders: string[] } {
    return { chats: [...this.chats], folders: [...this.folders] };
  }
}
