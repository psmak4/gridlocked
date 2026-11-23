import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { PricesScreen } from "@/components/play/prices-screen";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { getPrices, markSessionsWatched } from "@/server/play";
import { revealOf, SHOW_ALL } from "@/lib/shown-ids";
import { useRevealed } from "@/lib/use-revealed";

/**
 * `?show=changes` is the old address form of "Show it" (before M9): it still
 * reveals on the load it arrives with, then moves into the history entry's
 * state (`useRevealed`), which back and forward keep and a copied address
 * doesn't carry.
 */
type PricesSearch = { show?: "changes" };

/** The page's one reveal, the changes, as the state keeps it. */
const legacyOf = (show: "changes" | undefined) =>
  show === "changes" ? SHOW_ALL : undefined;

// Public (M6 decisions 3 and 4): a logged-out visitor's page is the same for
// everyone, so a CDN may keep it for a minute, and the revealed answer is
// cached apart from it. A signed-in one's carries their watched state.
export const Route = createFileRoute("/prices/")({
  validateSearch: (search: Record<string, unknown>): PricesSearch =>
    search.show === "changes" ? { show: "changes" } : {},
  loaderDeps: ({ search }) => ({ show: search.show }),
  head: () => ({ meta: [{ title: "Prices · Gridlocked" }] }),
  // Typed here: inferring `match` would make the loader's data optional.
  headers: ({ match }: { match: { context: { account?: unknown } } }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
  loader: async ({ deps, location }) =>
    await getPrices({
      data: {
        show: revealOf(location.state, legacyOf(deps.show)).all
          ? "changes"
          : undefined,
      },
    }),
  component: PricesRoute,
});

/** The price board (M6 Task 14). */
function PricesRoute() {
  const page = Route.useLoaderData();
  const { account } = Route.useRouteContext();
  const router = useRouter();
  const { reveal } = useRevealed(legacyOf(Route.useSearch().show));
  const raceId = page.board.changesFrom?.raceSessionId ?? null;
  return (
    <AppShell active="team">
      {!page.hasGame ? (
        <NoGame />
      ) : (
        <PricesScreen
          board={page.board}
          signedIn={Boolean(account)}
          onShow={() => reveal({ all: true })}
          markWatched={
            account && raceId
              ? () =>
                  void markSessionsWatched({
                    data: { sessionIds: [raceId] },
                  }).finally(() => router.invalidate())
              : undefined
          }
        />
      )}
    </AppShell>
  );
}
