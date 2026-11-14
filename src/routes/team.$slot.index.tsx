import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { privateHeaders } from "@/lib/private-headers";
import { getTeams } from "@/server/play";
import { isRefusal } from "@/server/play-actions";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/$slot/")({
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async ({ params }) => {
    const page = await getTeams();
    if (isRefusal(page)) throw new Error(`getTeams: ${page.error}`);
    const team = page.teams.find(
      (t) => String(t.slot) === params.slot && t.status === "active",
    );
    // No such active team: back to the list, which says what there is.
    if (!team) throw redirect({ to: "/team", search: { list: 1 } });
    return { team };
  },
  component: TeamBuilder,
});

/**
 * One team. The builder itself (picks, budget, save) arrives in M6 Task 8
 * (#188); until then it names the team and links back to the list.
 */
function TeamBuilder() {
  const { team } = Route.useLoaderData();
  return (
    <AppShell active="team">
      <div className="flex flex-col gap-space-3 px-space-4 py-space-4">
        <a
          href="/team?list=1"
          className="inline-flex min-h-[44px] items-center self-start text-[16px] font-bold text-heat-text underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          Your teams
        </a>
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal break-words uppercase">
          {team.name}
        </h1>
        <p className="m-0 text-[14px] text-ink-muted">Team {team.slot}</p>
      </div>
    </AppShell>
  );
}
