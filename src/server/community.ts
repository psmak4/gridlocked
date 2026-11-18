/**
 * The forum's server functions (M7). Each is a `createServerFn` with a Zod
 * `validator`, whose handler calls `communityAction`: the answer is private,
 * the viewer and the request's clock are read once, and a refusal comes back
 * as `{ ok: false, error }` for the screen to put in wave 4's words. An
 * `IdentityError` from a guard goes on to the middleware as before.
 *
 * `createServerFn(...).validator(...).handler(...)` stays written out at the
 * top level for each function, so Start's compiler finds it.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import {
  categoryPageInput,
  createThreadInput,
  deletePostInput,
  editPostInput,
  replyInput,
  sendChatInput,
  threadPageInput,
  voteInput,
} from "@/community/inputs";
import { chatReplay, type ChatReplay } from "@/community/archive";
import { sendChat, slowModeFor, chatState } from "@/community/chat";
import { composerData, writerOf } from "@/community/composer";
import { categoryList, threadList, threadPage } from "@/community/read";
import { deleteOwnPost, editPost, reply } from "@/community/posts";
import { createThread } from "@/community/threads";
import { vote } from "@/community/votes";
import type { Viewer } from "@/identity/viewer";
import { readerOf } from "@/play/weekend";
import { getSetting } from "@/settings";
import type { ServerDb } from "./db";
import { webChatArchiveStore } from "./chat-archive";
import { cacheFor } from "./public-cache";
import { getViewer, withRequestNow } from "./session";

// Not exported: only the handlers below use it, so the client build drops it.
async function communityAction<T>(
  fn: (db: ServerDb, now: Date, viewer: Viewer | null) => Promise<T>,
): Promise<T> {
  setResponseHeader("Cache-Control", "private, no-store");
  const viewer = await getViewer(getRequest());
  return withRequestNow((db, now) => fn(db, now, viewer));
}

/** "Start a thread" (TL1 and up, DM 5.3). */
export const createThreadFn = createServerFn({ method: "POST" })
  .validator(createThreadInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => createThread(db, now, viewer, data)),
  );

/** "Reply", at the top of a thread or under a post. */
export const replyFn = createServerFn({ method: "POST" })
  .validator(replyInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => reply(db, now, viewer, data)),
  );

/** "Edit" on the author's own post. */
export const editPostFn = createServerFn({ method: "POST" })
  .validator(editPostInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => editPost(db, now, viewer, data)),
  );

/** "Delete" on the author's own post: it stays as "[deleted]". */
export const deletePostFn = createServerFn({ method: "POST" })
  .validator(deletePostInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => deleteOwnPost(db, now, viewer, data)),
  );

/** A live chat message (DM 5.5). */
export const sendChatFn = createServerFn({ method: "POST" })
  .validator(sendChatInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => sendChat(db, now, viewer, data)),
  );

/** Up, down, or 0 to take a vote back. */
export const voteFn = createServerFn({ method: "POST" })
  .validator(voteInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => vote(db, now, viewer, data)),
  );

// --- Reads -------------------------------------------------------------------
// Public (HLD §7.3): a logged-out visitor's answer is spoiler-safe and the
// same for everyone, so a CDN may keep it; a signed-in one's carries their
// reveals and votes, so it is private.

/** `/forum`: the categories, and whether the viewer may start a thread. */
export const getForumFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const viewer = await getViewer(getRequest());
    cacheFor(viewer);
    return withRequestNow(async (db, now) => ({
      categories: await categoryList(db, now),
      writer: writerOf(viewer),
      /** The request's clock, for "3 h" and the like. */
      now: now.toISOString(),
    }));
  },
);

/** `/forum/$category`: its threads, hot or new. */
export const getCategoryFn = createServerFn({ method: "GET" })
  .validator(categoryPageInput)
  .handler(async ({ data }) => {
    const viewer = await getViewer(getRequest());
    cacheFor(viewer);
    return withRequestNow(async (db, now) => ({
      page: await threadList(db, now, readerOf(viewer), {
        categorySlug: data.slug,
        sort: data.sort,
        cursor: data.cursor,
        show: data.show,
        showAll: data.showAll,
      }),
      writer: writerOf(viewer),
      /** The request's clock, for "3 h" and the like. */
      now: now.toISOString(),
    }));
  });

/** `/t/$threadId`: the thread, or its cover while it would spoil. */
export const getThreadFn = createServerFn({ method: "GET" })
  .validator(threadPageInput)
  .handler(async ({ data }) => {
    const viewer = await getViewer(getRequest());
    cacheFor(viewer);
    return withRequestNow(async (db, now) => {
      const page = await threadPage(db, now, readerOf(viewer), data);
      let chat: { windowSeconds: number; slowSeconds: number } | null = null;
      if (page?.mode === "chat") {
        const [limits, state] = await Promise.all([
          getSetting(db, "chat_limits"),
          chatState(db, data.threadId),
        ]);
        chat = {
          windowSeconds: limits.windowSeconds,
          // A visitor sees the thread's own; a signed-in one, theirs.
          slowSeconds: viewer
            ? await slowModeFor(db, viewer, state?.slowMode ?? null)
            : Math.max(limits.slowModeSeconds.tl0, state?.slowMode ?? 0),
        };
      }
      // After the chat, its replay under the discussion (DM 5.5): only once
      // the thread is shown, so a cover never sends the chat along.
      let replay: ChatReplay | null = null;
      if (
        page &&
        page.mode === "discussion" &&
        !page.hidden &&
        page.thread.sessionId
      ) {
        replay = await chatReplay(
          db,
          await webChatArchiveStore(),
          data.threadId,
        );
      }
      return {
        page,
        chat,
        replay,
        writer: writerOf(viewer),
        /** The request's clock, for "3 h" and the like. */
        now: now.toISOString(),
      };
    });
  });

/** "New thread": where the viewer may start one, and the spoiler check. */
export const getComposerFn = createServerFn({ method: "GET" }).handler(() =>
  communityAction((db, now, viewer) => composerData(db, now, writerOf(viewer))),
);
