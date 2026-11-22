import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell, NoGame } from "@/components/app-shell";
import { TeamBuilder } from "@/components/play/team-builder";
import { privateHeaders } from "@/lib/private-headers";
import {
  getBuilder,
  markSessionsWatched,
  playLateCall,
  playTeamChip,
  saveTeam,
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
const searchSchema = z.object({ show: z.string().max(400).optional() });

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/")({
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ show: search.show }),
  loader: async ({ params, deps, location }) => {
    const slot = Number(params.slot);
    // Not a slot, or no active team in it: back to the list, which says
    // what there is.
    const toList = () => redirect({ to: "/team", search: { list: 1 } });
    if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw toList();
    const { ids } = revealOf(location.state, deps.show);
    const page = await getBuilder({
      data: { slot, ...(ids.length > 0 ? { show: ids } : {}) },
    });
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
  const { reveal } = useRevealed(Route.useSearch().show);
  return (
    <AppShell active="team">
      {page ? (
        <TeamBuilder
          page={page}
          save={(data) => saveTeam({ data })}
          playChip={(data) => playTeamChip({ data })}
          lateCall={(data) => playLateCall({ data })}
          markWatched={(sessionIds) =>
            markSessionsWatched({ data: { sessionIds } })
          }
          show={(id) => reveal({ ids: [id] })}
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
