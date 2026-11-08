import { redirect } from "@tanstack/react-router";
import { markPrivate, type AccountSummary } from "@/server/account";

/**
 * The onboarding steps are for someone signed in. A link that failed brings
 * `?error=` here (an email-verification link's callback), so that goes to
 * the page that offers a new one; a logged-out visitor goes to sign in.
 */
export async function onboardingGuard({
  account,
  search,
}: {
  account: AccountSummary | null;
  search: { error?: string };
}) {
  if (search.error !== undefined || !account) await markPrivate();
  if (search.error !== undefined) {
    throw redirect({ to: "/auth-error", search: { error: search.error } });
  }
  if (!account) throw redirect({ to: "/sign-in" });
}
