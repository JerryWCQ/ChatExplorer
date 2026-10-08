/**
 * Persistence for organizer conversations (「对话记录要留存」).
 *
 * Not routed through the data port, on purpose: a conversation log is not
 * library data — nothing in the file view depends on it, and broadcasting every
 * streamed turn to other tabs would make them reload the whole index for no
 * reason. The library changes the agent makes do go through the port.
 *
 * Writes happen at turn boundaries and after each tool call, never per token:
 * a turn is written when its response finishes streaming, and again each time
 * one of its tool calls completes.
 */

import { idb, tx } from "../core/db";
import { STORE } from "../core/schema";
import type { Session, Turn } from "./types";

export async function listSessions(): Promise<Session[]> {
  const rows = await tx([STORE.agentSessions], "readonly", (t) => idb.getAll<Session>(t, STORE.agentSessions));
  return rows.map(normalize).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Fields added after a session was first stored come back with defaults. */
function normalize(s: Session): Session {
  return { ...s, steps: s.steps ?? [], usage: s.usage ?? { input: 0, output: 0 } };
}

export async function loadTurns(sessionId: string): Promise<Turn[]> {
  return tx([STORE.agentTurns], "readonly", async (t) => {
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const rows = await new Promise<Turn[]>((resolve, reject) => {
      const req = t.objectStore(STORE.agentTurns).getAll(range);
      req.onsuccess = () => resolve(req.result as Turn[]);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => a.idx - b.idx);
  });
}

export async function saveSession(session: Session): Promise<void> {
  await tx([STORE.agentSessions], "readwrite", (t) => idb.put(t, STORE.agentSessions, session));
}

export async function putTurn(turn: Turn): Promise<void> {
  // Structured clone would copy the live objects the UI is still mutating;
  // a JSON round trip also drops anything non-serialisable by accident.
  const row = JSON.parse(JSON.stringify(turn)) as Turn;
  await tx([STORE.agentTurns], "readwrite", (t) => idb.put(t, STORE.agentTurns, row));
}

/** Drop turn `fromIdx` and everything after it — the conversation half of a rewind. */
export async function truncateTurns(sessionId: string, fromIdx: number): Promise<void> {
  await tx([STORE.agentTurns], "readwrite", (t) => {
    const range = IDBKeyRange.bound([sessionId, fromIdx], [sessionId, Number.MAX_SAFE_INTEGER]);
    return new Promise<void>((resolve, reject) => {
      const req = t.objectStore(STORE.agentTurns).delete(range);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

export async function deleteSession(id: string): Promise<void> {
  await truncateTurns(id, 0);
  await tx([STORE.agentSessions], "readwrite", (t) => idb.del(t, STORE.agentSessions, id));
}

/** Every undo step any session made — see `Session.steps`. */
export async function allAgentSteps(): Promise<Set<number>> {
  const out = new Set<number>();
  for (const s of await listSessions()) for (const seq of s.steps) out.add(seq);
  return out;
}
