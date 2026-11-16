import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { LeaguesScreen } from "@/components/play/leagues-screen";
import { privateHeaders } from "@/lib/private-headers";
import { getLeagues, joinMyLeague } from "@/server/play";
import { isRefusal } from "@/server/play-actions";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/leagues/")({
  head: () => ({ meta: [{ title: "Leagues · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async () => {
    const page = await getLeagues();
    if (isRefusal(page)) throw new Error(`getLeagues: ${page.error}`);
    return page;
  },
  component: LeaguesRoute,
});

/** My leagues (M6 Task 12): join, create, and the ones you're in. */
function LeaguesRoute() {
  const page = Route.useLoaderData();
  const router = useRouter();
  return (
    <AppShell active="leagues">
      {page.game ? (
        <LeaguesScreen
          page={page}
          join={(data) => joinMyLeague({ data })}
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
