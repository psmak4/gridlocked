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
  createThreadInput,
  deletePostInput,
  editPostInput,
  replyInput,
  voteInput,
} from "@/community/inputs";
import { deleteOwnPost, editPost, reply } from "@/community/posts";
import { createThread } from "@/community/threads";
import { vote } from "@/community/votes";
import type { Viewer } from "@/identity/viewer";
import type { ServerDb } from "./db";
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

/** Up, down, or 0 to take a vote back. */
export const voteFn = createServerFn({ method: "POST" })
  .validator(voteInput)
  .handler(({ data }) =>
    communityAction((db, now, viewer) => vote(db, now, viewer, data)),
  );
