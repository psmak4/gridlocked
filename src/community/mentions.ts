import { and, eq, inArray, ne } from "drizzle-orm";
import { postMentions, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { mentionedNames } from "./text";

/** An ltree label for a uuid: labels allow letters, digits and `_`. */
export const pathLabel = (id: string) => id.replaceAll("-", "_");

/**
 * Writes `post_mentions` for the people `body` mentions (DM 5.4): known,
 * not deleted, and not the author. A name mentioned twice is one row, and a
 * row already there stays. Returns the people newly mentioned.
 */
export async function writeMentions(
  db: Db,
  postId: string,
  authorUserId: string,
  body: string,
): Promise<string[]> {
  const names = mentionedNames(body);
  if (names.length === 0) return [];
  const people = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        inArray(users.username, names),
        ne(profiles.status, "deleted"),
        ne(users.id, authorUserId),
      ),
    );
  if (people.length === 0) return [];
  const written = await db
    .insert(postMentions)
    .values(people.map((p) => ({ postId, userId: p.id })))
    .onConflictDoNothing()
    .returning({ userId: postMentions.userId });
  return written.map((w) => w.userId);
}
