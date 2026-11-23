/**
 * "Show it" on a page (M9 Task 4): what this history entry revealed, kept
 * in `history.state` so back and forward keep it and a copied address
 * doesn't. An old `?show=` link still reveals on the load it arrives with,
 * then moves into the state and leaves the address.
 */
import { useEffect } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  revealOf,
  withoutRevealed,
  withRevealed,
  type Revealed,
} from "./shown-ids";

/**
 * Whether the page the server rendered has been looked at. The server never
 * sees history state, so a page loaded fresh (a reload, or back to an entry
 * after a full page load) arrives covered even when its entry revealed it.
 */
let serverPageSeen = false;

export function useRevealed(legacy: string | undefined): {
  revealed: Revealed;
  reveal: (more: Partial<Revealed>) => void;
  hideAll: () => void;
} {
  const navigate = useNavigate();
  const router = useRouter();
  const shown = useLocation({ select: (l) => l.state.shown });
  const revealed = revealOf({ shown }, legacy);

  // The server's page, for an entry that revealed something: load it again
  // with the reveal. Later pages' loaders read the state themselves.
  useEffect(() => {
    if (serverPageSeen) return;
    serverPageSeen = true;
    const kept = revealOf({ shown });
    if (kept.all || kept.ids.length > 0) void router.invalidate();
    // Once, on the first page this browser tab hydrates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (next: (state: object | undefined) => object) =>
    void navigate({
      to: ".",
      // The old address form goes; everything else in it stays.
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        show: undefined,
      })) as never,
      state: next as never,
      replace: true,
      resetScroll: false,
    });

  useEffect(() => {
    if (legacy === undefined) return;
    move((state) => withRevealed(state, revealOf(undefined, legacy)));
    // Once, for the address the page arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacy]);

  return {
    revealed,
    reveal: (more) =>
      move((state) =>
        withRevealed(state, { ids: more.ids ?? [], all: more.all ?? false }),
      ),
    hideAll: () => move((state) => withoutRevealed(state)),
  };
}
