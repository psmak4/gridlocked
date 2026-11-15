import { describe, expect, it } from "vitest";
import type { LineupPick } from "@/game/lineups";
import { createDraftStore, draftKey, readDraft, samePicks } from "./use-draft";

/** A `Storage` over a map, as a browser's `localStorage` behaves. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

/** A `Storage` that throws on every call, as a blocked one does. */
const blocked = () =>
  new Proxy({} as Storage, {
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });

const KEY = draftKey("team-1", "event-1");
const PICKS: LineupPick[] = [
  { assetId: "a", isBoost: true },
  { assetId: "b", isBoost: false },
];

describe("drafts", () => {
  it("the key names the team and the event", () => {
    expect(KEY).toBe("gridlocked:draft:team-1:event-1");
  });

  it("a draft survives a reload", () => {
    const storage = memoryStorage();
    createDraftStore(() => storage).write(KEY, JSON.stringify(PICKS));
    // A new page: a new store over the same storage.
    expect(
      readDraft(
        createDraftStore(() => storage),
        KEY,
      ),
    ).toEqual(PICKS);
  });

  it("a save clears it", () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.write(KEY, JSON.stringify(PICKS));
    store.remove(KEY);
    expect(readDraft(store, KEY)).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("no storage still works", () => {
    for (const storage of [
      () => null,
      () => blocked(),
      () => {
        throw new DOMException("denied", "SecurityError");
      },
    ]) {
      const store = createDraftStore(storage);
      expect(readDraft(store, KEY)).toBeNull();
      store.write(KEY, JSON.stringify(PICKS));
      expect(readDraft(store, KEY)).toEqual(PICKS);
      store.remove(KEY);
      expect(readDraft(store, KEY)).toBeNull();
    }
  });

  it("text that isn't a list of picks is no draft", () => {
    const store = createDraftStore(() => memoryStorage());
    for (const bad of ["not json", "{}", '[{"assetId":1}]']) {
      store.write(KEY, bad);
      expect(readDraft(store, KEY)).toBeNull();
    }
  });

  it("a write tells subscribers", () => {
    const store = createDraftStore(() => memoryStorage());
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.write(KEY, "[]");
    store.remove(KEY);
    stop();
    store.write(KEY, "[]");
    expect(calls).toBe(2);
  });

  it("the same picks in another order are the same team", () => {
    expect(samePicks(PICKS, [...PICKS].reverse())).toBe(true);
    expect(
      samePicks(PICKS, [
        { assetId: "a", isBoost: false },
        { assetId: "b", isBoost: true },
      ]),
    ).toBe(false);
    expect(samePicks(PICKS, PICKS.slice(1))).toBe(false);
  });
});
