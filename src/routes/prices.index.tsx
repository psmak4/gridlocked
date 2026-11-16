import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { PricesScreen } from "@/components/play/prices-screen";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { getPrices, markSessionsWatched } from "@/server/play";

/** `show=changes`: the changes on this page only ("Show it"), never stored. */
type PricesSearch = { show?: "changes" };

// Public (M6 decisions 3 and 4): a logged-out visitor's page is the same for
// everyone, so a CDN may keep it for a minute, and `?show=changes` is cached
// as a page of its own. A signed-in one's carries their watched state.
export const Route = createFileRoute("/prices/")({
  validateSearch: (search: Record<string, unknown>): PricesSearch =>
    search.show === "changes" ? { show: "changes" } : {},
  loaderDeps: ({ search }) => ({ show: search.show }),
  head: () => ({ meta: [{ title: "Prices · Gridlocked" }] }),
  // Typed here: inferring `match` would make the loader's data optional.
  headers: ({ match }: { match: { context: { account?: unknown } } }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
  loader: async ({ deps }) => await getPrices({ data: { show: deps.show } }),
  component: PricesRoute,
});

/** The price board (M6 Task 14). */
function PricesRoute() {
  const page = Route.useLoaderData();
  const { account } = Route.useRouteContext();
  const router = useRouter();
  const raceId = page.board.changesFrom?.raceSessionId ?? null;
  return (
    <AppShell active="team">
      {!page.hasGame ? (
        <NoGame />
      ) : (
        <PricesScreen
          board={page.board}
          signedIn={Boolean(account)}
          showHref="/prices?show=changes"
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
