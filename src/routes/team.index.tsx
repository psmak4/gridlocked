import { createFileRoute } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { getCurrentGame } from "@/server/play";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/")({
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getCurrentGame(),
  component: TeamPage,
});

/**
 * Team, in the app shell. Before the game opens it says so; the screen
 * itself arrives in M6 Task 6 (#186).
 */
function TeamPage() {
  const game = Route.useLoaderData();
  return (
    <AppShell active="team">
      {game ? (
        <EmptyState
          headingLevel={1}
          title="No teams yet"
          body="Your teams for the season will be here."
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
