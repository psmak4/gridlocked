import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and on the first client render, true after hydration
 * (HLD §11.4). Controls that need the client stay disabled until it is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
