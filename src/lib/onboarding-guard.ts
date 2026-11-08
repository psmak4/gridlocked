import { redirect } from "@tanstack/react-router";
import type { AccountSummary } from "@/server/account";

/**
 * The onboarding steps are for someone signed in. A link that failed brings
 * `?error=` here (an email-verification link's callback), so that goes to
 * the page that offers a new one; a logged-out visitor goes to sign in.
 */
export function onboardingGuard({
  account,
  search,
}: {
  account: AccountSummary | null;
  search: { error?: string };
}) {
  if (search.error !== undefined) {
    throw redirect({ to: "/auth-error", search: { error: search.error } });
  }
  if (!account) throw redirect({ to: "/sign-in" });
}
