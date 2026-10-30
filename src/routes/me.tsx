import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "@/spike/auth-client";
import { cacheControl } from "@/spike/cache";
import { adminCheck, getSessionUser } from "@/spike/session";

export const Route = createFileRoute("/me")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/sign-in" });
    return { user };
  },
  loader: () => adminCheck(),
  headers: () => ({ "Cache-Control": cacheControl("private") }),
  head: () => ({ meta: [{ title: "You · Gridlocked" }] }),
  component: Me,
});

function Me() {
  const { user } = Route.useRouteContext();
  const { admin } = Route.useLoaderData();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    await router.navigate({ to: "/sign-in" });
  }

  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">Signed in</h1>
      <p data-testid="email">{user.email}</p>
      <p data-testid="role">{admin ? "Admin" : "Member"}</p>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </main>
  );
}
