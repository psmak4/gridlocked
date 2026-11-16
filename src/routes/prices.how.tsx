import { createFileRoute } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { HowPricesScreen } from "@/components/play/prices-screen";
import { publicHeaders } from "@/lib/public-headers";
import { getHowPrices } from "@/server/play";

// The same for everyone, signed in or not: public and cacheable.
export const Route = createFileRoute("/prices/how")({
  head: () => ({ meta: [{ title: "How prices work · Gridlocked" }] }),
  headers: () => publicHeaders(),
  loader: () => getHowPrices(),
  component: HowPricesRoute,
});

/** How prices work (M6 Task 14). */
function HowPricesRoute() {
  const page = Route.useLoaderData();
  return (
    <AppShell active="team">
      {page.hasGame ? <HowPricesScreen how={page.how} /> : <NoGame />}
    </AppShell>
  );
}
