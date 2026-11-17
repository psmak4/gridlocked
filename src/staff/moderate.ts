/**
 * `pnpm staff moderate` (M7 Task 12): one moderation action from the staff
 * workflow, until M8's queue screen. The target is a post, thread or chat
 * message by id, or a user by username; a category by slug. A dry run
 * resolves everything and says what would happen; the real run calls
 * `moderate`, which writes `mod_actions` and `audit_log` with the reason and
 * the login of whoever started the run.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, users } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  M7_MOD_ACTIONS,
  moderate,
  type ModerateInput,
  type ModerateResult,
} from "@/community/moderate";
import type { StaffActor } from "./roster";

export const moderateChange = z
  .strictObject({
    action: z.enum(M7_MOD_ACTIONS as [string, ...string[]]),
    target: z.enum(["post", "thread", "chat_message", "user"]),
    /** For a post, a thread or a chat message. */
    id: z.uuid().optional(),
    /** For a user. */
    username: z.string().trim().min(1).max(64).optional(),
    /** For `mute` and `chat_ban`; left out means until lifted. */
    until: z.iso.datetime({ offset: true }).optional(),
    queueItem: z.uuid().optional(),
    version: z.number().int().min(0).optional(),
    /** For `retitle`. */
    title: z.string().trim().min(1).max(120).optional(),
    /** For `move`: the category's slug. */
    category: z.string().trim().min(1).max(60).optional(),
  })
  .refine((c) => (c.target === "user") === (c.username !== undefined), {
    message: "a user is named by username, anything else by id",
  })
  .refine((c) => c.target === "user" || c.id !== undefined, {
    message: "id is required",
  })
  .refine((c) => (c.queueItem === undefined) === (c.version === undefined), {
    message: "queueItem and version go together",
  });

export type ModerateChange = z.infer<typeof moderateChange>;

export type ModerateReport = {
  dryRun: boolean;
  command: "moderate";
  resolved: {
    action: string;
    targetType: string;
    targetId: string;
    /** Only the username for a user: nothing else about them. */
    username?: string;
    categoryId?: string;
  };
  result?: ModerateResult;
};

export async function runModerate(
  db: Db,
  now: Date,
  cmd: {
    change: ModerateChange;
    reason: string;
    actor: StaffActor;
    dryRun: boolean;
  },
): Promise<ModerateReport> {
  const c = cmd.change;
  let targetId = c.id!;
  let username: string | undefined;
  if (c.target === "user") {
    const [user] = await db
      .select({ id: users.id, displayUsername: users.displayUsername })
      .from(users)
      .where(eq(sql`lower(${users.username})`, c.username!.toLowerCase()));
    if (!user) throw new Error(`no user ${c.username}`);
    targetId = user.id;
    username = user.displayUsername ?? c.username;
  }
  let categoryId: string | undefined;
  if (c.category) {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, c.category));
    if (!category) throw new Error(`no category ${c.category}`);
    categoryId = category.id;
  }
  const resolved = {
    action: c.action,
    targetType: c.target,
    targetId,
    ...(username ? { username } : {}),
    ...(categoryId ? { categoryId } : {}),
  };
  if (cmd.dryRun) return { dryRun: true, command: "moderate", resolved };

  const input: ModerateInput = {
    action: c.action as ModerateInput["action"],
    targetType: c.target,
    targetId,
    reason: cmd.reason,
    ...(c.until ? { until: new Date(c.until) } : {}),
    ...(c.queueItem ? { queueItemId: c.queueItem, version: c.version } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(categoryId ? { categoryId } : {}),
  };
  const result = await moderate(
    db,
    now,
    {
      userId: null,
      kind: "admin",
      label: cmd.actor.label,
      ...(cmd.actor.requestId ? { requestId: cmd.actor.requestId } : {}),
    },
    input,
  );
  if (!result.ok) throw new Error(`moderate refused: ${result.error}`);
  return { dryRun: false, command: "moderate", resolved, result };
}
