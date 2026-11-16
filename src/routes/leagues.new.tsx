import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { CreateLeagueForm } from "@/components/play/create-league-form";
import { InviteCode } from "@/components/play/leagues-screen";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { createMyLeague, getLeagues } from "@/server/play";
import { isRefusal } from "@/play/refusal";

export const Route = createFileRoute("/leagues/new")({
  head: () => ({ meta: [{ title: "Create a league · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async () => {
    const page = await getLeagues();
    if (isRefusal(page)) throw new Error(`getLeagues: ${page.error}`);
    return page;
  },
  component: NewLeagueRoute,
});

const backLink =
  "flex min-h-[44px] items-center self-start text-[16px] font-bold text-ink-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

/**
 * Create a league (M6 Task 12). After it's made, the code to send, with
 * Copy: the code is the way in, for a public league too.
 */
function NewLeagueRoute() {
  const page = Route.useLoaderData();
  const [made, setMade] = useState<{ joinCode: string; name: string } | null>(
    null,
  );

  if (!page.game) {
    return (
      <AppShell active="leagues">
        <NoGame />
      </AppShell>
    );
  }
  if (page.teams.length === 0) {
    return (
      <AppShell active="leagues">
        <EmptyState
          headingLevel={1}
          title="Build a team first"
          body="A league is for teams. Build yours, then create a league."
          action={
            <Button staticLink href="/team">
              Build your team
            </Button>
          }
        />
      </AppShell>
    );
  }

  return (
    <AppShell active="leagues">
      <div className="flex flex-col gap-space-4 px-space-4 pt-space-4 pb-space-6 lg:max-w-[560px]">
        <a href="/leagues" className={backLink}>
          ← Leagues
        </a>
        {made ? (
          <>
            <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
              {made.name}
            </h1>
            <p className="m-0 text-[16px] leading-[22px]">
              Your league is ready. Send the code to the people you want in.
            </p>
            <InviteCode code={made.joinCode} />
            <Button staticLink href="/leagues" size="l" block>
              Done
            </Button>
          </>
        ) : (
          <>
            <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
              Create a league
            </h1>
            <CreateLeagueForm
              teams={page.teams}
              rounds={page.rounds}
              create={(data) => createMyLeague({ data })}
              onCreated={({ joinCode, name }) => setMade({ joinCode, name })}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
