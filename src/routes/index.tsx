import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { linkClass } from "@/components/account-layout";
import { authClient } from "@/identity/auth-client";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { account } = Route.useRouteContext();
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">GRIDLOCKED</h1>
      <p>Coming for the 2027 season.</p>
      {account ? (
        <div className="mt-space-4 flex flex-col items-start gap-space-2">
          <p>Signed in as {account.username}</p>
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
      ) : (
        <p className="mt-space-4 flex gap-space-4">
          <a href="/sign-up" className={linkClass}>
            Sign up
          </a>
          <a href="/sign-in" className={linkClass}>
            Sign in
          </a>
        </p>
      )}
    </main>
  );
}
