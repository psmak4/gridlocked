/**
 * The Zod inputs for the community server functions. Zod and the limits
 * only: the screens' forms import these, so nothing here may reach the
 * database code.
 */
import { z } from "zod";
import { CHAT_BODY_MAX, POST_BODY_MAX, THREAD_TITLE_MAX } from "./limits";
import {
  REPORT_NOTE_MAX,
  REPORT_REASONS,
  REPORTABLE_TYPES,
} from "./report-values";

const body = z.string().trim().min(1).max(POST_BODY_MAX);

export const createThreadInput = z.object({
  categoryId: z.uuid(),
  title: z.string().trim().min(1).max(THREAD_TITLE_MAX),
  body,
  sessionId: z.uuid().nullish(),
  containsSpoilers: z.boolean().optional(),
});

export const replyInput = z.object({
  threadId: z.uuid(),
  parentPostId: z.uuid().nullish(),
  body,
});

export const sendChatInput = z.object({
  threadId: z.uuid(),
  body: z.string().trim().min(1).max(CHAT_BODY_MAX),
});

/**
 * "Report" (DM 5.8). Signed in, the reporter is the viewer; logged out, a
 * contact address and a Turnstile token come with it.
 */
export const reportInput = z.object({
  targetType: z.enum(REPORTABLE_TYPES),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(REPORT_NOTE_MAX).optional(),
  contact: z.email().max(254).optional(),
  captchaToken: z.string().max(4096).optional(),
});

export const editPostInput = z.object({ postId: z.uuid(), body });

export const deletePostInput = z.object({ postId: z.uuid() });

export const voteInput = z.object({
  postId: z.uuid(),
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

/** `?show=`: the session or thread ids revealed on this page only. */
const show = z.array(z.uuid()).max(10).optional();

export const categoryPageInput = z.object({
  slug: z.string().min(1).max(60),
  sort: z.enum(["hot", "new"]).default("hot"),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .nullish(),
  show,
  /** `?show=all`: a visitor's device shows every result. */
  showAll: z.boolean().optional(),
});

export const threadPageInput = z.object({
  threadId: z.uuid(),
  postId: z.uuid().nullish(),
  sort: z.enum(["best", "new"]).default("best"),
  show,
  showAll: z.boolean().optional(),
});
