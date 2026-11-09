import { redirect } from "@tanstack/react-router";
import { markPrivate, type AccountSummary } from "@/server/account";

/**
 * The profile and settings pages are for someone signed in: a logged-out
 * visitor goes to sign in. The redirect depends on the cookie, so it is
 * private too (route `headers()` don't run for a redirect).
 */
export async function settingsGuard({
  account,
}: {
  account: AccountSummary | null;
}) {
  if (account) return;
  await markPrivate();
  throw redirect({ to: "/sign-in" });
}
