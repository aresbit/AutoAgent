/**
 * Turn-level persistent outbox.
 *
 * A turn id is generated before the request leaves the SPA. The pending entry
 * is written to localStorage first, so a crash, reload or lost connection does
 * not lose the user's input. On the next load the entry is reconciled against
 * `GET /api/turns/{turnId}`:
 *
 * - running  -> attach to the same turn (the backend is idempotent by id)
 * - finished -> drop the entry (the user message is already persisted)
 * - 404      -> replay with the same id (the request never reached the backend)
 *
 * The backend persists the user message with the turn id before starting, so a
 * replay never duplicates it.
 */

export interface PendingTurn {
  turnId: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

export const PENDING_TURNS_KEY = "autoagent.pendingTurns.v1";
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function parse(raw: string | null): PendingTurn[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: PendingTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.turnId !== "string" ||
      typeof record.sessionId !== "string" ||
      typeof record.text !== "string" ||
      typeof record.createdAt !== "number" ||
      !record.text.trim()
    ) {
      continue;
    }
    entries.push({
      turnId: record.turnId,
      sessionId: record.sessionId,
      text: record.text,
      createdAt: record.createdAt,
    });
  }
  return entries;
}

export function readPendingTurns(
  storage: StorageLike | null,
  now = Date.now(),
): PendingTurn[] {
  if (!storage) return [];
  return parse(storage.getItem(PENDING_TURNS_KEY)).filter(
    (entry) => now - entry.createdAt < MAX_AGE_MS,
  );
}

export function addPendingTurn(
  storage: StorageLike | null,
  entry: PendingTurn,
  now = Date.now(),
): void {
  if (!storage) return;
  const entries = readPendingTurns(storage, now).filter(
    (item) => item.turnId !== entry.turnId,
  );
  entries.push(entry);
  write(storage, entries.slice(-MAX_ENTRIES));
}

export function removePendingTurn(
  storage: StorageLike | null,
  turnId: string,
  now = Date.now(),
): void {
  if (!storage) return;
  const entries = readPendingTurns(storage, now).filter(
    (item) => item.turnId !== turnId,
  );
  write(storage, entries);
}

export function pendingTurnsForSession(
  storage: StorageLike | null,
  sessionId: string,
  now = Date.now(),
): PendingTurn[] {
  return readPendingTurns(storage, now).filter(
    (entry) => entry.sessionId === sessionId,
  );
}

function write(storage: StorageLike, entries: PendingTurn[]): void {
  try {
    storage.setItem(PENDING_TURNS_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be full or disabled; the live request still proceeds.
  }
}
