import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import {
  CreateTeamForm,
  RemoveTeamSheet,
  RenameTeamSheet,
} from "@/components/play/team-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import type { TeamSummary } from "@/play/teams";
import {
  createMyTeam,
  getTeams,
  removeMyTeam,
  renameMyTeam,
} from "@/server/play";
import { isRefusal } from "@/server/play-actions";

/** `list`: show the list even with one team (the builder's "Your teams"). */
type TeamSearch = { list?: 1 };

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/team/")({
  validateSearch: (search: Record<string, unknown>): TeamSearch =>
    search.list === 1 || search.list === "1" ? { list: 1 } : {},
  loaderDeps: ({ search }) => ({ list: search.list === 1 }),
  head: () => ({ meta: [{ title: "Team · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async ({ deps }) => {
    const page = await getTeams();
    if (isRefusal(page)) throw new Error(`getTeams: ${page.error}`);
    // With one team, Team is that team.
    const [only] = page.teams;
    if (!deps.list && page.teams.length === 1 && only!.status === "active") {
      throw redirect({
        to: "/team/$slot",
        params: { slot: String(only!.slot) },
      });
    }
    return page;
  },
  component: TeamPage,
});

/**
 * Team (M6 Task 6): "No team yet" and the create form with no team, and the
 * list of up to 3 with Rename and Remove once there is more than one. The
 * builder itself is `/team/$slot`.
 */
function TeamPage() {
  const page = Route.useLoaderData();
  const router = useRouter();
  const [renaming, setRenaming] = useState<TeamSummary | null>(null);
  const [removing, setRemoving] = useState<TeamSummary | null>(null);

  if (!page.game) {
    return (
      <AppShell active="team">
        <NoGame />
      </AppShell>
    );
  }

  const create = (name: string) => createMyTeam({ data: { name } });
  const toBuilder = async (slot: number) => {
    await router.navigate({
      to: "/team/$slot",
      params: { slot: String(slot) },
    });
  };
  // Stays on the list after a change, even with one team left.
  const refresh = async () => {
    setRenaming(null);
    setRemoving(null);
    await router.navigate({ to: "/team", search: { list: 1 }, replace: true });
    await router.invalidate();
  };

  if (page.teams.length === 0) {
    return (
      <AppShell active="team">
        <EmptyState
          headingLevel={1}
          title="No team yet"
          body="Name your team, then pick its drivers and constructors."
          action={<CreateTeamForm create={create} onCreated={toBuilder} />}
        />
      </AppShell>
    );
  }

  return (
    <AppShell active="team">
      <div className="flex flex-col gap-space-4 px-space-4 py-space-4">
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
          Your teams
        </h1>
        <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
          {page.teams.map((team) => (
            <li
              key={team.id}
              className="flex flex-wrap items-center gap-space-3 rounded-radius-m bg-surface-raised px-space-3 py-space-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                {team.status === "active" ? (
                  <a
                    href={`/team/${team.slot}`}
                    className="flex min-h-[44px] items-center text-[18px] font-bold break-words text-ink no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    {team.name}
                  </a>
                ) : (
                  <span className="flex min-h-[44px] items-center text-[18px] font-bold break-words text-ink-muted">
                    {team.name}
                  </span>
                )}
                <span className="flex items-center gap-space-2 text-[14px] text-ink-muted">
                  Team {team.slot}
                  {team.status === "retired" ? (
                    <Badge tone="neutral">Retired</Badge>
                  ) : null}
                </span>
              </div>
              {team.status === "active" ? (
                <div className="flex gap-space-2">
                  <Button variant="quiet" onClick={() => setRenaming(team)}>
                    Rename
                  </Button>
                  <Button variant="quiet" onClick={() => setRemoving(team)}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {page.canCreate ? (
          <section
            aria-labelledby="new-team"
            className="flex flex-col gap-space-3"
          >
            <h2
              id="new-team"
              className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase"
            >
              Another team
            </h2>
            <CreateTeamForm create={create} onCreated={toBuilder} />
          </section>
        ) : null}
      </div>
      <RenameTeamSheet
        key={`rename-${renaming?.id ?? ""}`}
        team={renaming}
        onClose={() => setRenaming(null)}
        rename={(teamId, name) => renameMyTeam({ data: { teamId, name } })}
        onDone={refresh}
      />
      <RemoveTeamSheet
        key={`remove-${removing?.id ?? ""}`}
        team={removing}
        onClose={() => setRemoving(null)}
        remove={(teamId) => removeMyTeam({ data: { teamId } })}
        onDone={refresh}
      />
    </AppShell>
  );
}
