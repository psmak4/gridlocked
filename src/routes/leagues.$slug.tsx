import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { StandingsScreen } from "@/components/play/standings-screen";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import {
  getStandings,
  leaveMyLeague,
  markSessionsWatched,
} from "@/server/play";
import { isRefusal } from "@/play/refusal";
import { revealOf } from "@/lib/shown-ids";
import { useRevealed } from "@/lib/use-revealed";

/**
 * `?show=` is the old address form of "Show it" (before M9): it still
 * reveals on the load it arrives with, then moves into the history entry's
 * state (`useRevealed`), which back and forward keep and a copied address
 * doesn't carry.
 */
type StandingsSearch = { show?: string };

export const Route = createFileRoute("/leagues/$slug")({
  validateSearch: (search: Record<string, unknown>): StandingsSearch =>
    typeof search.show === "string" && search.show.length > 0
      ? { show: search.show }
      : {},
  loaderDeps: ({ search }) => ({ show: search.show }),
  head: () => ({ meta: [{ title: "League standings · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async ({ params, deps, location }) => {
    const show = revealOf(location.state, deps.show).ids;
    const page = await getStandings({
      data: { slug: params.slug, ...(show.length ? { show } : {}) },
    });
    if (isRefusal(page)) {
      if (page.error === "league_not_found") return { page: null, show };
      throw new Error(`getStandings: ${page.error}`);
    }
    // With what it revealed, so the screen starts again only once the
    // revealed page has loaded.
    return { page, show };
  },
  component: StandingsRoute,
});

/** League standings (M6 Task 13). */
function StandingsRoute() {
  const { page, show } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const router = useRouter();
  const { reveal } = useRevealed(search.show);
  return (
    <AppShell active="leagues">
      {page === null ? (
        <EmptyState
          headingLevel={1}
          title="No league here"
          body="This league isn't there, or it's private. Ask a member for its code."
        />
      ) : (
        <StandingsScreen
          key={`${slug}:${show.join(",")}`}
          page={page}
          more={(afterRank, version) =>
            getStandings({
              data: {
                slug,
                afterRank,
                version,
                ...(show.length ? { show } : {}),
              },
            })
          }
          show={(ids) => reveal({ ids })}
          markWatched={(sessionIds) =>
            markSessionsWatched({ data: { sessionIds } })
          }
          leave={(data) => leaveMyLeague({ data })}
          onLeft={async () => {
            await router.navigate({ to: "/leagues" });
          }}
          reload={() => router.invalidate()}
        />
      )}
    </AppShell>
  );
}
