import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { linkClass } from "@/components/account-layout";
import { AppShell, NoGame } from "@/components/app-shell";
import { HomeScreen } from "@/components/play/home-screen";
import { Button } from "@/components/ui/button";
import { authClient } from "@/identity/auth-client";
import { getHome, markSessionsWatched } from "@/server/play";
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

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ show: search.show }),
  // A logged-out home never opens the database (M5): only someone signed in
  // gets the fantasy blocks.
  loader: async ({ context, deps, location }) => {
    if (!context.account) return { home: null };
    const { ids } = revealOf(location.state, deps.show);
    const home = await getHome({
      data: ids.length > 0 ? { show: ids } : {},
    });
    if (isRefusal(home)) throw new Error(`getHome: ${home.error}`);
    return { home };
  },
  component: Home,
});

function Home() {
  const { account } = Route.useRouteContext();
  const { home } = Route.useLoaderData();
  if (!account || !home) return <LoggedOutHome />;
  return <SignedInHome home={home} username={account.username ?? ""} />;
}

/** Home for someone signed in (wave 3's "Home in race week"). */
function SignedInHome({
  home,
  username,
}: {
  home: NonNullable<ReturnType<typeof Route.useLoaderData>["home"]>;
  username: string;
}) {
  const router = useRouter();
  const { reveal } = useRevealed(Route.useSearch().show);
  return (
    <AppShell active="home">
      {home.hasGame ? (
        <HomeScreen
          home={home}
          show={(ids) => reveal({ ids })}
          markWatched={(sessionIds) =>
            markSessionsWatched({ data: { sessionIds } })
          }
          reload={() => router.invalidate()}
        />
      ) : (
        <NoGame />
      )}
      <div className="mt-space-4 flex flex-col items-start gap-space-2 px-space-4 pb-space-6">
        <p className="m-0">Signed in as {username}</p>
        <p className="m-0 flex gap-space-4">
          <a href="/settings" className={linkClass}>
            Settings
          </a>
        </p>
        <Button
          type="button"
          variant="quiet"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign("/");
          }}
        >
          Sign out
        </Button>
      </div>
    </AppShell>
  );
}

/** The M5 home, with a way to this weekend (decision 3). */
function LoggedOutHome() {
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">GRIDLOCKED</h1>
      <p>Coming for the 2027 season.</p>
      <p className="mt-space-4">
        <a href="/weekend" className={linkClass}>
          See this weekend
        </a>
      </p>
      <p className="mt-space-4 flex gap-space-4">
        <a href="/sign-up" className={linkClass}>
          Sign up
        </a>
        <a href="/sign-in" className={linkClass}>
          Sign in
        </a>
      </p>
    </main>
  );
}
