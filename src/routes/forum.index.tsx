import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { canStartIn } from "@/community/writer";
import {
  CategoryRow,
  ForumPage,
  pageTitle,
} from "@/components/community/forum-screens";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { getForumFn } from "@/server/community";

// Public (HLD §7.3): the same for every logged-out visitor, so a CDN may
// keep it; a signed-in one's says whether they may start a thread.
export const Route = createFileRoute("/forum/")({
  head: () => ({ meta: [{ title: "Forum · Gridlocked" }] }),
  headers: ({ match }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
  loader: () => getForumFn(),
  component: ForumRoute,
});

/** The forum's front page (wave 4): the categories, and "New thread". */
function ForumRoute() {
  const { categories, writer } = Route.useLoaderData();
  return (
    <AppShell active="forum">
      <ForumPage>
        <div className="flex items-center justify-between gap-space-3">
          <h1 className={pageTitle}>Forum</h1>
          {canStartIn(writer, 1) ? (
            <Button variant="secondary" staticLink href="/forum/new">
              New thread
            </Button>
          ) : null}
        </div>
        <ul
          aria-label="Categories"
          className="m-0 flex list-none flex-col gap-space-2 p-0"
        >
          {categories.map((c) => (
            <CategoryRow key={c.id} category={c} />
          ))}
        </ul>
      </ForumPage>
    </AppShell>
  );
}
