import { createFileRoute } from "@tanstack/react-router";
import { AppShell, NoGame } from "@/components/app-shell";
import { HowPricesScreen } from "@/components/play/prices-screen";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { getHowPrices } from "@/server/play";

// The formula is the same for everyone, but the page carries the viewer's
// account, so only a logged-out visitor's page is public and cacheable.
export const Route = createFileRoute("/prices/how")({
  head: () => ({ meta: [{ title: "How prices work · Gridlocked" }] }),
  // Typed here: inferring `match` would make the loader's data optional.
  headers: ({ match }: { match: { context: { account?: unknown } } }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
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
