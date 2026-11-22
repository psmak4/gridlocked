import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { canStartIn } from "@/community/writer";
import {
  ForumPage,
  backLink,
  pageTitle,
} from "@/components/community/forum-screens";
import {
  DeviceRevealSwitch,
  useDeviceReveal,
} from "@/components/community/device-reveal";
import { ThreadRowItem } from "@/components/community/thread-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs } from "@/components/ui/tabs";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { revealOf } from "@/lib/shown-ids";
import { useRevealed } from "@/lib/use-revealed";
import { getCategoryFn } from "@/server/community";

/** `?sort=new` for the newest; hot by default. `?page=` is the next page's cursor. */
const searchSchema = z.object({
  sort: z.enum(["hot", "new"]).optional().catch(undefined),
  page: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional()
    .catch(undefined),
  show: z.string().max(400).optional(),
});

// Public (HLD §7.3): spoiler-safe for a logged-out visitor, so a CDN may
// keep it; a signed-in one's carries their reveals.
export const Route = createFileRoute("/forum/$category")({
  head: () => ({ meta: [{ title: "Forum · Gridlocked" }] }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    sort: search.sort ?? "hot",
    page: search.page,
    // The old address form of a reveal (`useRevealed`).
    show: search.show,
  }),
  loader: async ({ params, deps, location }) => {
    const shown = revealOf(location.state, deps.show);
    const result = await getCategoryFn({
      data: {
        slug: params.category,
        sort: deps.sort,
        cursor: deps.page ?? null,
        ...(shown.ids.length > 0 ? { show: shown.ids } : {}),
        ...(shown.all ? { showAll: true } : {}),
      },
    });
    if (!result.page) throw notFound();
    return {
      ...result,
      page: result.page,
      nowMs: Date.parse(result.now),
      showAll: shown.all,
    };
  },
  // After the loader: a function here before `validateSearch` loses the
  // search's type.
  headers: ({ match }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
  component: CategoryRoute,
});

/** A category's threads (wave 4): Hot or New, pinned first. */
function CategoryRoute() {
  const { page, writer, nowMs, showAll } = Route.useLoaderData();
  const { sort } = Route.useLoaderDeps();
  const navigate = Route.useNavigate();
  const { category } = page;
  // A visitor's device choice (HLD §7.3): "all" reveals the page in its
  // history entry, never in the address.
  const visitor = writer === null;
  const hasHidden = page.threads.some((row) => row.hidden);
  const { reveal, hideAll } = useRevealed(Route.useSearch().show);
  useDeviceReveal({
    visitor,
    hasHidden,
    showAll,
    showEverything: () => reveal({ all: true }),
  });
  return (
    <AppShell active="forum">
      <ForumPage>
        <a href="/forum" className={backLink}>
          ← Forum
        </a>
        <div className="flex items-center justify-between gap-space-3">
          <h1 className={pageTitle}>{category.name}</h1>
          {canStartIn(writer, category.minTrustToStartThread) ? (
            <Button
              variant="secondary"
              staticLink
              href={`/forum/new?category=${category.slug}`}
            >
              New thread
            </Button>
          ) : null}
        </div>
        <Tabs
          label="Sort threads"
          items={[
            { id: "hot", label: "Hot" },
            { id: "new", label: "New" },
          ]}
          value={sort}
          onChange={(next) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                sort: next === "new" ? "new" : undefined,
                page: undefined,
              }),
            })
          }
        />
        {visitor && (hasHidden || showAll) ? (
          <DeviceRevealSwitch
            on={showAll}
            onShowAll={() => reveal({ all: true })}
            onShowSafe={hideAll}
          />
        ) : null}
        {page.threads.length === 0 ? (
          <EmptyState title="No threads yet" body="Start the first one." />
        ) : (
          <ul
            aria-label="Threads"
            className="m-0 flex list-none flex-col gap-space-2 p-0"
          >
            {page.threads.map((row) => (
              <ThreadRowItem key={row.id} row={row} nowMs={nowMs} />
            ))}
          </ul>
        )}
        {page.nextCursor ? (
          <Button
            variant="quiet"
            staticLink
            href={`/forum/${category.slug}?${new URLSearchParams({
              ...(sort === "new" ? { sort } : {}),
              page: page.nextCursor,
            }).toString()}`}
          >
            More threads
          </Button>
        ) : null}
      </ForumPage>
    </AppShell>
  );
}
