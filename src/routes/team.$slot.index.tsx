import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { TeamBuilder } from "@/components/play/team-builder";
import { privateHeaders } from "@/lib/private-headers";
import { getBuilder, saveTeam } from "@/server/play";
import { isRefusal } from "@/server/play-actions";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/")({
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async ({ params }) => {
    const slot = Number(params.slot);
    // Not a slot, or no active team in it: back to the list, which says
    // what there is.
    const toList = () => redirect({ to: "/team", search: { list: 1 } });
    if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw toList();
    const page = await getBuilder({ data: { slot } });
    if (isRefusal(page)) {
      if (page.error === "game_not_open") return { page: null };
      throw toList();
    }
    return { page };
  },
  component: TeamBuilderRoute,
});

/** One team's builder (wave 2). */
function TeamBuilderRoute() {
  const { page } = Route.useLoaderData();
  const router = useRouter();
  return (
    <AppShell active="team">
      {page ? (
        <TeamBuilder
          page={page}
          save={(data) => saveTeam({ data })}
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
