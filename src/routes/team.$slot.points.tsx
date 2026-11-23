import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell, NoGame } from "@/components/app-shell";
import { PointsBreakdown } from "@/components/play/points-breakdown";
import { privateHeaders } from "@/lib/private-headers";
import { getBreakdown, markSessionsWatched } from "@/server/play";
import { isRefusal } from "@/play/refusal";
import { revealOf } from "@/lib/shown-ids";
import { useRevealed } from "@/lib/use-revealed";

/**
 * `?round=` picks the round, the team's latest by default. `?show=` is the
 * old address form of "Show it" (before M9): it still reveals on the load it
 * arrives with, then moves into the history entry's state (`useRevealed`).
 */
const searchSchema = z.object({
  round: z.coerce.number().int().min(1).max(30).optional().catch(undefined),
  show: z.string().max(400).optional(),
});

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/points")({
  // The title never names a result (design-system README).
  head: () => ({ meta: [{ title: "Your points · Gridlocked" }] }),
  headers: privateHeaders,
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    round: search.round,
    show: search.show,
  }),
  loader: async ({ params, deps, location }) => {
    const slot = Number(params.slot);
    const toList = () => redirect({ to: "/team", search: { list: 1 } });
    if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw toList();
    const { ids } = revealOf(location.state, deps.show);
    const page = await getBreakdown({
      data: {
        slot,
        ...(deps.round !== undefined ? { round: deps.round } : {}),
        ...(ids.length > 0 ? { show: ids } : {}),
      },
    });
    if (isRefusal(page)) {
      if (page.error === "game_not_open") return { page: null };
      throw toList();
    }
    return { page };
  },
  component: PointsRoute,
});

/** One team's points by session (wave 3). */
function PointsRoute() {
  const { page } = Route.useLoaderData();
  const router = useRouter();
  const { reveal } = useRevealed(Route.useSearch().show);
  return (
    <AppShell active="team">
      {page ? (
        <PointsBreakdown
          page={page}
          show={(id) => reveal({ ids: [id] })}
          markWatched={(sessionIds) =>
            markSessionsWatched({ data: { sessionIds } })
          }
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
