import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { NotificationsScreen } from "@/components/notifications-screen";
import { privateHeaders } from "@/lib/private-headers";
import { getNotificationsFn, markReadFn } from "@/server/notifications";

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/notifications")({
  head: () => ({ meta: [{ title: "Notifications · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getNotificationsFn(),
  component: NotificationsRoute,
});

/** The bell's list (Task 13). */
function NotificationsRoute() {
  const { items } = Route.useLoaderData();
  const router = useRouter();
  return (
    <AppShell active="notifications">
      <NotificationsScreen
        items={items}
        markAll={async () => {
          await markReadFn({ data: { all: true } });
          await router.invalidate();
        }}
        open={async (item) => {
          if (item.unread) await markReadFn({ data: { ids: [item.id] } });
          window.location.assign(item.href);
        }}
      />
    </AppShell>
  );
}
