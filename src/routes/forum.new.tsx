import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { NewThreadForm } from "@/components/community/composer";
import {
  ForumPage,
  backLink,
  pageTitle,
} from "@/components/community/forum-screens";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { privateHeaders } from "@/lib/private-headers";
import { createThreadFn, getComposerFn } from "@/server/community";

const searchSchema = z.object({
  category: z.string().max(60).optional().catch(undefined),
});

// For someone signed in: the root gate sends a logged-out visitor to sign in
// and back (`signInFirst`).
export const Route = createFileRoute("/forum/new")({
  head: () => ({ meta: [{ title: "New thread · Gridlocked" }] }),
  headers: privateHeaders,
  validateSearch: searchSchema,
  loader: () => getComposerFn(),
  component: NewThreadRoute,
});

/** "New thread" (wave 4). */
function NewThreadRoute() {
  const data = Route.useLoaderData();
  const { category } = Route.useSearch();
  const navigate = useNavigate();
  const back = category ? `/forum/${category}` : "/forum";
  return (
    <AppShell active="forum">
      <ForumPage>
        <a href={back} className={backLink}>
          Cancel
        </a>
        <h1 className={pageTitle}>New thread</h1>
        {data.categories.length === 0 ? (
          <EmptyState
            title="You can't start threads yet"
            body="New accounts reply and vote first. Keep taking part and you can start your own soon."
            action={
              <Button variant="secondary" staticLink href="/forum">
                Back to the forum
              </Button>
            }
          />
        ) : (
          <NewThreadForm
            data={data}
            initialCategory={category}
            onSubmit={async (thread) => {
              const result = await createThreadFn({ data: thread });
              if (result.ok) {
                await navigate({
                  to: "/t/$threadId",
                  params: { threadId: result.threadId },
                });
              }
              return result;
            }}
          />
        )}
      </ForumPage>
    </AppShell>
  );
}
