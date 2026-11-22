import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { linkClass } from "@/components/account-layout";
import { AppShell, NoGame } from "@/components/app-shell";
import { HomeScreen } from "@/components/play/home-screen";
import { Button } from "@/components/ui/button";
import { authClient } from "@/identity/auth-client";
import { pushOff } from "@/lib/push-actions";
import { signOutHere } from "@/lib/sign-out";
import { getHome, markSessionsWatched } from "@/server/play";
import { isRefusal } from "@/play/refusal";

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

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ show: shownIds(search.show) }),
  // A logged-out home never opens the database (M5): only someone signed in
  // gets the fantasy blocks.
  loader: async ({ context, deps }) => {
    if (!context.account) return { home: null };
    const home = await getHome({
      data: deps.show.length > 0 ? { show: deps.show } : {},
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
  const navigate = Route.useNavigate();
  return (
    <AppShell active="home">
      {home.hasGame ? (
        <HomeScreen
          home={home}
          show={(ids) =>
            void navigate({
              search: (prev) => ({
                show: [...new Set([...shownIds(prev.show), ...ids])].join(","),
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
            await signOutHere({
              forgetPush: pushOff,
              signOut: () => authClient.signOut(),
            });
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
