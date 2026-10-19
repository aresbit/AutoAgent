import { describe, expect, it } from "vitest";
import {
  PENDING_TURNS_KEY,
  addPendingTurn,
  pendingTurnsForSession,
  readPendingTurns,
  removePendingTurn,
} from "@/features/chat/outbox";

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => map,
  };
}

const entry = {
  turnId: "t1",
  sessionId: "s1",
  text: "hello",
  createdAt: 1000,
};

describe("turn outbox", () => {
  it("persists one entry per turn id", () => {
    const store = storage();
    addPendingTurn(store, entry, 3000);
    addPendingTurn(store, { ...entry, createdAt: 2000 }, 3000);

    const entries = readPendingTurns(store, 3000);
    expect(entries).toHaveLength(1);
    expect(entries[0].createdAt).toBe(2000);
  });

  it("removes a completed turn and filters by session", () => {
    const store = storage();
    addPendingTurn(store, entry, 3000);
    addPendingTurn(store, { ...entry, turnId: "t2", sessionId: "s2" }, 3000);

    expect(
      pendingTurnsForSession(store, "s1", 3000).map((item) => item.turnId),
    ).toEqual(["t1"]);
    removePendingTurn(store, "t1", 3000);
    expect(readPendingTurns(store, 3000).map((item) => item.turnId)).toEqual(["t2"]);
  });

  it("ignores malformed and expired entries", () => {
    const store = storage({
      [PENDING_TURNS_KEY]: JSON.stringify([
        { turnId: "old", sessionId: "s", text: "x", createdAt: 0 },
        { turnId: 1, sessionId: "s", text: "x", createdAt: 10 },
        { turnId: "ok", sessionId: "s", text: "x", createdAt: 900 },
        "nope",
      ]),
    });
    // 24h + 1ms after the "old" entry.
    expect(readPendingTurns(store, 24 * 60 * 60 * 1000 + 1).map((item) => item.turnId)).toEqual([
      "ok",
    ]);
  });

  it("tolerates invalid JSON and disabled storage", () => {
    const store = storage({ [PENDING_TURNS_KEY]: "{" });
    expect(readPendingTurns(store, 1)).toEqual([]);
    expect(readPendingTurns(null, 1)).toEqual([]);
    expect(() => addPendingTurn(null, entry)).not.toThrow();
  });
});
