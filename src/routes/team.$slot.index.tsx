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
import { isRefusal } from "@/server/play-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?show=<id>,<id>`: the sessions "Show it" revealed on this page. It lives
 * in the URL, so it lasts until the page is left and is never stored.
 */
const searchSchema = z.object({ show: z.string().max(400).optional() });
const shownIds = (show: string | undefined) =>
  (show ?? "")
    .split(",")
    .filter((id) => UUID.test(id))
    .slice(0, 10);

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/")({
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ show: shownIds(search.show) }),
  loader: async ({ params, deps }) => {
    const slot = Number(params.slot);
    // Not a slot, or no active team in it: back to the list, which says
    // what there is.
    const toList = () => redirect({ to: "/team", search: { list: 1 } });
    if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw toList();
    const page = await getBuilder({
      data: { slot, ...(deps.show.length > 0 ? { show: deps.show } : {}) },
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
  const navigate = Route.useNavigate();
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
          show={(id) =>
            void navigate({
              search: (prev) => ({
                show: [...new Set([...shownIds(prev.show), id])].join(","),
              }),
              replace: true,
              resetScroll: false,
            })
          }
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
    </AppShell>
  );
}
