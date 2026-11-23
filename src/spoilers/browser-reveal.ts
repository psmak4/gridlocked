/**
 * A visitor's spoiler choice for this device (HLD §7.3, M7 Task 10): "safe"
 * by default, or "all" after "Show results everywhere on this device". It
 * lives in `localStorage` only, so it never reaches the server or the CDN:
 * a page that should show more asks for it with `showAll` from its history
 * entry's state (M9 Task 4), and the default page carries nothing hidden.
 *
 * Storage can be missing or refuse (private windows, blocked site data), so
 * every read and write is in a `try`, and a failure is "safe".
 */
export type BrowserReveal = "safe" | "all";

export const REVEAL_KEY = "gridlocked:reveal";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function createBrowserReveal(store: () => StorageLike | null = storage) {
  return {
    get(): BrowserReveal {
      try {
        return store()?.getItem(REVEAL_KEY) === "all" ? "all" : "safe";
      } catch {
        return "safe";
      }
    },
    set(value: BrowserReveal): void {
      try {
        if (value === "all") store()?.setItem(REVEAL_KEY, "all");
        else store()?.removeItem(REVEAL_KEY);
      } catch {
        // Nothing to keep it in: the choice lasts for this page only.
      }
    },
  };
}

export const browserReveal = createBrowserReveal();
