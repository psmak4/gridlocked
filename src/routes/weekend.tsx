import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { WeekendHub } from "@/components/play/weekend-hub";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders, weekendCache } from "@/lib/public-headers";
import { getWeekend, markSessionsWatched } from "@/server/play";

// Public (M6 decision 3): a logged-out visitor's page is the same for
// everyone, so a CDN may keep it for a minute. A signed-in one's carries
// their watched state.
export const Route = createFileRoute("/weekend")({
  head: () => ({ meta: [{ title: "This weekend · Gridlocked" }] }),
  // Near the lock the stale copy lives 10 seconds, not 30 (M9 Task 6).
  headers: ({ match, loaderData }) =>
    match.context.account
      ? privateHeaders()
      : publicHeaders(loaderData ? weekendCache(loaderData) : undefined),
  loader: () => getWeekend(),
  component: WeekendRoute,
});

/** The weekend hub (wave 3). */
function WeekendRoute() {
  const page = Route.useLoaderData();
  const router = useRouter();
  const { weekend } = page;
  return (
    <AppShell active="home">
      {!page.hasGame ? (
        <NoGame />
      ) : weekend ? (
        <WeekendHub
          page={{ ...page, weekend }}
          markWatched={(sessionIds) =>
            markSessionsWatched({ data: { sessionIds } })
          }
          reload={() => router.invalidate()}
        />
      ) : (
        <EmptyState
          headingLevel={1}
          title="No race this weekend"
          body="The next weekend shows here when its calendar is in."
        />
      )}
    </AppShell>
  );
}
