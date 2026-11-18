import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ChatReplayView, ChatView } from "@/components/community/chat-view";
import {
  DeviceRevealSwitch,
  useDeviceReveal,
} from "@/components/community/device-reveal";
import { ReplyForm } from "@/components/community/composer";
import {
  ForumPage,
  backLink,
  eyebrow,
  pageTitle,
} from "@/components/community/forum-screens";
import { ago } from "@/components/community/forum-words";
import {
  PostItem,
  PostTree,
  type PostActions,
} from "@/components/community/post-tree";
import {
  ReportSheet,
  type ReportTarget,
} from "@/components/community/report-sheet";
import { Badge } from "@/components/ui/badge";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import { Tabs } from "@/components/ui/tabs";
import { systemTimer } from "@/lib/clock";
import { privateHeaders } from "@/lib/private-headers";
import { publicHeaders } from "@/lib/public-headers";
import { SHOW_ALL, shownIds, showsAll, withShown } from "@/lib/shown-ids";
import { createRefreshChannel } from "@/realtime/refresh";
import {
  getThreadFn,
  replyFn,
  reportFn,
  sendChatFn,
  voteFn,
} from "@/server/community";
import { markSessionsWatched } from "@/server/play";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?post=` opens the page at one reply ("Continue thread"), `?sort=new` for
 * the newest first, and `?show=` holds what "Show it" revealed here.
 */
const searchSchema = z.object({
  post: z.string().regex(UUID).optional().catch(undefined),
  sort: z.enum(["best", "new"]).optional().catch(undefined),
  show: z.string().max(400).optional(),
});

// Public (HLD §7.3): spoiler-safe for a logged-out visitor, so a CDN may
// keep it; a signed-in one's carries their reveals and votes.
export const Route = createFileRoute("/t/$threadId")({
  // The title never names a result: a thread's own title may.
  head: () => ({ meta: [{ title: "Forum · Gridlocked" }] }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    post: search.post,
    sort: search.sort ?? "best",
    show: shownIds(search.show),
    showAll: showsAll(search.show),
  }),
  loader: async ({ params, deps }) => {
    if (!UUID.test(params.threadId)) throw notFound();
    const result = await getThreadFn({
      data: {
        threadId: params.threadId,
        postId: deps.post ?? null,
        sort: deps.sort,
        ...(deps.show.length > 0 ? { show: deps.show } : {}),
        ...(deps.showAll ? { showAll: true } : {}),
      },
    });
    if (!result.page) throw notFound();
    return { ...result, page: result.page, nowMs: Date.parse(result.now) };
  },
  // After the loader: a function here before `validateSearch` loses the
  // search's type.
  headers: ({ match }) =>
    match.context.account ? privateHeaders() : publicHeaders(),
  component: ThreadRoute,
});

const commentsWords = (n: number) =>
  `${new Intl.NumberFormat("en-GB").format(n)} ${n === 1 ? "comment" : "comments"}`;

/** A thread (wave 4): the opening post, then the comments as a tree. */
function ThreadRoute() {
  const { page, writer, nowMs, chat, replay } = Route.useLoaderData();
  const { sort, showAll } = Route.useLoaderDeps();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const { thread } = page;
  const open = thread.status === "open";
  const [reporting, setReporting] = useState<ReportTarget | null>(null);

  const actions: PostActions = {
    writer,
    open,
    nowMs,
    vote: (postId, value) => voteFn({ data: { postId, value } }),
    reply: async (parentPostId, body) => {
      const result = await replyFn({
        data: { threadId: thread.id, parentPostId, body },
      });
      if (result.ok) await router.invalidate();
      return result;
    },
    continueHref: (postId) => `/t/${thread.id}?post=${postId}`,
    // The opening post stands for its thread.
    report: (post) =>
      setReporting(
        post.isOpening
          ? {
              targetType: "thread",
              targetId: thread.id,
              what: "this thread",
            }
          : {
              targetType: "post",
              targetId: post.id,
              what: `the post by ${post.author ?? "a deleted user"}`,
            },
      ),
  };

  // Chat mode (HLD §7.2): one channel for the page while it lasts. It is
  // made only once the thread is shown, so a viewer who hasn't revealed the
  // session never asks for its chat.
  const chatting = chat !== null && !page.hidden;
  const channel = useMemo(
    () =>
      chatting
        ? createRefreshChannel({
            windowSeconds: chat.windowSeconds,
            offsetMs: nowMs - systemTimer.now(),
            send: (threadId, body) => sendChatFn({ data: { threadId, body } }),
            onModeChange: (mode) => {
              if (mode === "discussion") void router.invalidate();
            },
          })
        : null,
    // One channel per thread while it is shown in chat mode; the loader's
    // clock seeds it once, and each refresh corrects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread.id, chatting, chat?.windowSeconds],
  );

  // A visitor's device choice (HLD §7.3): "all" asks for `?show=all`.
  const visitor = writer === null;
  const setShow = (show: string | undefined) =>
    void navigate({
      search: (prev) => ({ ...prev, show }),
      replace: true,
      resetScroll: false,
    });
  useDeviceReveal({
    visitor,
    hasHidden: page.hidden,
    showAll,
    showEverything: () => setShow(SHOW_ALL),
  });
  const deviceSwitch =
    visitor && (page.hidden || showAll) ? (
      <DeviceRevealSwitch
        on={showAll}
        onShowAll={() => setShow(SHOW_ALL)}
        onShowSafe={() => setShow(undefined)}
      />
    ) : null;

  const opening = page.posts.find((p) => p.isOpening);
  const replies = page.posts.filter((p) => !p.isOpening);
  const revealId = thread.sessionId ?? thread.id;

  return (
    <AppShell active="forum" bottomNav={!chatting}>
      <ForumPage>
        <a href={`/forum/${thread.categorySlug}`} className={backLink}>
          {`← ${thread.categoryName}`}
        </a>
        <div className="flex flex-col gap-space-1">
          {thread.badge === "pinned" ? (
            <Badge className="self-start">Pinned</Badge>
          ) : null}
          <h1 className={pageTitle}>{thread.title}</h1>
          <p className="m-0 text-[14px] text-ink-muted">
            {[
              thread.author,
              page.hidden
                ? `${commentsWords(thread.replyCount)} hidden`
                : commentsWords(thread.replyCount),
              ago(thread.createdAt, nowMs),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {page.hidden ? (
          <SpoilerCover
            hidden
            title="Spoiler protected"
            body={
              thread.sessionPhrase
                ? `Comments in this thread may give away the result. You haven't marked ${thread.sessionPhrase} as watched.`
                : "Comments in this thread may give away a result."
            }
            onReveal={() =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  show: withShown(prev.show, revealId),
                }),
                replace: true,
                resetScroll: false,
              })
            }
            onMarkWatched={
              writer && thread.sessionId
                ? () =>
                    void markSessionsWatched({
                      data: { sessionIds: [thread.sessionId!] },
                    }).finally(() => router.invalidate())
                : undefined
            }
          />
        ) : null}
        {deviceSwitch}
        {page.hidden ? null : chatting && channel ? (
          <ChatView
            threadId={thread.id}
            channel={channel}
            writer={writer}
            slowSeconds={chat.slowSeconds}
            phrase={thread.sessionPhrase ?? "the session"}
            signInHref={`/sign-in?next=${encodeURIComponent(`/t/${thread.id}`)}`}
            onClosed={() => void router.invalidate()}
            onReport={(m) =>
              setReporting({
                targetType: "chat_message",
                targetId: m.id,
                what: `the message from ${m.author}`,
              })
            }
          />
        ) : (
          <>
            {page.focusPostId ? (
              <a href={`/t/${thread.id}`} className={backLink}>
                ← The whole thread
              </a>
            ) : opening ? (
              <PostItem post={opening} actions={actions} heading />
            ) : null}

            {!open ? (
              <p className="m-0 rounded-radius-m bg-surface-sunken px-space-3 py-space-2 text-[14px] font-bold">
                {thread.status === "archived"
                  ? "This thread is archived."
                  : "This thread is locked."}
              </p>
            ) : null}

            <div className="mt-space-2 flex items-center justify-between gap-space-3">
              <h2 className={eyebrow}>Comments</h2>
            </div>
            <Tabs
              label="Sort comments"
              items={[
                { id: "best", label: "Best" },
                { id: "new", label: "New" },
              ]}
              value={sort}
              onChange={(next) =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    sort: next === "new" ? "new" : undefined,
                  }),
                  replace: true,
                  resetScroll: false,
                })
              }
            />

            {open && writer?.canPost && !page.focusPostId ? (
              <ReplyForm
                label="Add a comment"
                submitLabel="Post comment"
                onSubmit={(body) => actions.reply(null, body)}
              />
            ) : !writer ? (
              <p className="m-0 text-[14px] text-ink-muted">
                <a
                  href={`/sign-in?next=${encodeURIComponent(`/t/${thread.id}`)}`}
                  className="font-bold text-ink"
                >
                  Sign in
                </a>{" "}
                to comment and vote.
              </p>
            ) : null}

            {replies.length === 0 ? (
              <p className="m-0 text-[16px] text-ink-muted">No comments yet.</p>
            ) : (
              <PostTree posts={replies} actions={actions} />
            )}

            {replay ? <ChatReplayView replay={replay} /> : null}
          </>
        )}
      </ForumPage>
      <ReportSheet
        target={reporting}
        visitor={writer === null}
        onClose={() => setReporting(null)}
        submit={(data) => reportFn({ data })}
      />
    </AppShell>
  );
}
