import { createFileRoute, redirect } from "@tanstack/react-router";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { staffMenu } from "@/staff/menu";

/**
 * `/staff` opens the first screen this person may use: the review queue for
 * an admin, moderation for a moderator.
 */
export const Route = createFileRoute("/staff/")({
  beforeLoad: ({ context }) => {
    const [first] = staffMenu(context.staff.role);
    if (first) throw redirect({ href: first.href });
  },
  headers: privateHeaders,
  component: NoScreens,
});

function NoScreens() {
  return (
    <EmptyState
      headingLevel={1}
      title="No staff screens yet"
      body="Your screens appear in the menu as they're built."
    />
  );
}
