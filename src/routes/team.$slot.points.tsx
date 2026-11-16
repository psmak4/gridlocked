import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell, NoGame } from "@/components/app-shell";
import { PointsBreakdown } from "@/components/play/points-breakdown";
import { privateHeaders } from "@/lib/private-headers";
import { getBreakdown, markSessionsWatched } from "@/server/play";
import { isRefusal } from "@/server/play-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?round=` picks the round, the team's latest by default. `?show=<id>,<id>`
 * holds the sessions "Show it" revealed on this page: it lasts until the
 * page is left and is never stored.
 */
const searchSchema = z.object({
  round: z.coerce.number().int().min(1).max(30).optional().catch(undefined),
  show: z.string().max(400).optional(),
});
const shownIds = (show: string | undefined) =>
  (show ?? "")
    .split(",")
    .filter((id) => UUID.test(id))
    .slice(0, 10);

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/points")({
  // The title never names a result (design-system README).
  head: () => ({ meta: [{ title: "Your points · Gridlocked" }] }),
  headers: privateHeaders,
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    round: search.round,
    show: shownIds(search.show),
  }),
  loader: async ({ params, deps }) => {
    const slot = Number(params.slot);
    const toList = () => redirect({ to: "/team", search: { list: 1 } });
    if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw toList();
    const page = await getBreakdown({
      data: {
        slot,
        ...(deps.round !== undefined ? { round: deps.round } : {}),
        ...(deps.show.length > 0 ? { show: deps.show } : {}),
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
  const navigate = Route.useNavigate();
  return (
    <AppShell active="team">
      {page ? (
        <PointsBreakdown
          page={page}
          show={(id) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                show: [...new Set([...shownIds(prev.show), id])].join(","),
              }),
              replace: true,
              resetScroll: false,
            })
          }
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
