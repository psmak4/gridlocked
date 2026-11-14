/**
 * The builder's unsaved picks (DM 3.7): kept in the browser under
 * `gridlocked:draft:<teamId>:<eventId>`, cleared on a successful save. Every
 * read and write is in a try/catch: in a private window, or with storage
 * blocked, the draft lives in memory for the page instead.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { LineupPick } from "@/game/lineups";

export const draftKey = (teamId: string, eventId: string) =>
  `gridlocked:draft:${teamId}:${eventId}`;

/** Picks from stored text, or null if it isn't a list of picks. */
function parsePicks(raw: string | null): LineupPick[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      Array.isArray(value) &&
      value.every(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as LineupPick).assetId === "string" &&
          typeof (p as LineupPick).isBoost === "boolean",
      )
    ) {
      return (value as LineupPick[]).map(({ assetId, isBoost }) => ({
        assetId,
        isBoost,
      }));
    }
  } catch {
    // Not JSON: no draft.
  }
  return null;
}

/** The same picks, in any order. */
export function samePicks(a: LineupPick[], b: LineupPick[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: LineupPick) => `${p.assetId}:${p.isBoost ? 1 : 0}`;
  const theirs = new Set(b.map(key));
  return a.every((p) => theirs.has(key(p)));
}

export type DraftStore = {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  remove: (key: string) => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Drafts over `storage()` (the browser's `localStorage`), with a memory
 * fallback when it is missing or throws.
 */
export function createDraftStore(storage: () => Storage | null): DraftStore {
  const memory = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const store = (): Storage | null => {
    try {
      return storage();
    } catch {
      return null;
    }
  };
  return {
    read(key) {
      try {
        const s = store();
        if (s) return s.getItem(key);
      } catch {
        // Blocked: the memory copy.
      }
      return memory.get(key) ?? null;
    },
    write(key, value) {
      memory.set(key, value);
      try {
        store()?.setItem(key, value);
      } catch {
        // Full or blocked: the memory copy stands.
      }
      notify();
    },
    remove(key) {
      memory.delete(key);
      try {
        store()?.removeItem(key);
      } catch {
        // Blocked: nothing stored.
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Reads a draft's picks from `store`, or null. */
export function readDraft(store: DraftStore, key: string): LineupPick[] | null {
  return parsePicks(store.read(key));
}

const browserDrafts = createDraftStore(() =>
  typeof window === "undefined" ? null : window.localStorage,
);

/**
 * The picks being edited for one team and event: the draft if there is one,
 * else `saved` (the latest save, or the base), else none. `setPicks` keeps
 * a draft, dropping it when it matches `saved`; `clear` drops it after a
 * save. On the server and the first client render there is no draft, so the
 * page hydrates from the saved team and then shows the draft.
 */
export function useDraft(
  teamId: string,
  eventId: string,
  saved: LineupPick[] | null,
  store: DraftStore = browserDrafts,
): {
  picks: LineupPick[];
  setPicks: (picks: LineupPick[]) => void;
  clear: () => void;
  fromServer: boolean;
} {
  const key = draftKey(teamId, eventId);
  const raw = useSyncExternalStore(
    store.subscribe,
    () => store.read(key),
    () => null,
  );
  const draft = useMemo(() => parsePicks(raw), [raw]);
  const setPicks = useCallback(
    (picks: LineupPick[]) => {
      if (samePicks(picks, saved ?? [])) store.remove(key);
      else store.write(key, JSON.stringify(picks));
    },
    [store, key, saved],
  );
  const clear = useCallback(() => store.remove(key), [store, key]);
  return {
    picks: draft ?? saved ?? [],
    setPicks,
    clear,
    fromServer: draft === null,
  };
}
