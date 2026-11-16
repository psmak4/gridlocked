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

/** `show`: sessions revealed on this page only ("Show it"); never stored. */
type StandingsSearch = { show?: string };

export const Route = createFileRoute("/leagues/$slug")({
  validateSearch: (search: Record<string, unknown>): StandingsSearch =>
    typeof search.show === "string" && search.show.length > 0
      ? { show: search.show }
      : {},
  loaderDeps: ({ search }) => ({ show: search.show }),
  head: () => ({ meta: [{ title: "League standings · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async ({ params, deps }) => {
    const show = deps.show?.split(",").filter(Boolean) ?? [];
    const page = await getStandings({
      data: { slug: params.slug, ...(show.length ? { show } : {}) },
    });
    if (isRefusal(page)) {
      if (page.error === "league_not_found") return null;
      throw new Error(`getStandings: ${page.error}`);
    }
    return page;
  },
  component: StandingsRoute,
});

/** League standings (M6 Task 13). */
function StandingsRoute() {
  const page = Route.useLoaderData();
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const router = useRouter();
  const show = search.show?.split(",").filter(Boolean) ?? [];
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
          key={`${slug}:${search.show ?? ""}`}
          page={page}
          more={(afterRank) =>
            getStandings({
              data: { slug, afterRank, ...(show.length ? { show } : {}) },
            })
          }
          show={(ids) =>
            void router.navigate({
              to: "/leagues/$slug",
              params: { slug },
              search: { show: [...new Set([...show, ...ids])].join(",") },
              replace: true,
            })
          }
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
