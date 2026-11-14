import { createFileRoute } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { getCurrentGame } from "@/server/play";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/leagues/")({
  head: () => ({ meta: [{ title: "Leagues · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getCurrentGame(),
  component: LeaguesPage,
});

/**
 * Leagues, in the app shell. Before the game opens it says so; the screen
 * itself arrives in M6 Task 12 (#192).
 */
function LeaguesPage() {
  const game = Route.useLoaderData();
  return (
    <AppShell active="leagues">
      {game ? (
        <EmptyState
          headingLevel={1}
          title="No leagues yet"
          body="The leagues you play in will be here."
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
