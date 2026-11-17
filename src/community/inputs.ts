/**
 * The Zod inputs for the community server functions. Zod and the limits
 * only: the screens' forms import these, so nothing here may reach the
 * database code.
 */
import { z } from "zod";
import { POST_BODY_MAX, THREAD_TITLE_MAX } from "./limits";

const body = z.string().trim().min(1).max(POST_BODY_MAX);

export const createThreadInput = z.object({
  categoryId: z.uuid(),
  title: z.string().trim().min(1).max(THREAD_TITLE_MAX),
  body,
  sessionId: z.uuid().nullish(),
  containsSpoilers: z.boolean().default(false),
});

export const replyInput = z.object({
  threadId: z.uuid(),
  parentPostId: z.uuid().nullish(),
  body,
});

export const editPostInput = z.object({ postId: z.uuid(), body });

export const deletePostInput = z.object({ postId: z.uuid() });

export const voteInput = z.object({
  postId: z.uuid(),
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});
