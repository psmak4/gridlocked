import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { NotificationsScreen } from "@/components/notifications-screen";
import { PushSheet } from "@/components/push-sheet";
import { openNotification } from "@/lib/open-notification";
import { loadPush, pushOff, pushOn } from "@/lib/push-actions";
import { useHydrated } from "@/lib/use-hydrated";
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
  const hydrated = useHydrated();
  const [pushOpen, setPushOpen] = useState(false);
  return (
    <AppShell active="notifications">
      <NotificationsScreen
        items={items}
        markAll={async () => {
          await markReadFn({ data: { all: true } });
          await router.invalidate();
        }}
        open={(item) =>
          openNotification(item, {
            markRead: (id) => markReadFn({ data: { ids: [id] } }),
            go: (href) => window.location.assign(href),
          })
        }
        onPush={hydrated ? () => setPushOpen(true) : undefined}
      />
      <PushSheet
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        load={loadPush}
        turnOn={pushOn}
        turnOff={pushOff}
      />
    </AppShell>
  );
}
