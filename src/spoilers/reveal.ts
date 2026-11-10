/**
 * The spoiler check (DM 5.7, HLD §7.3). A session is revealed for a reader if
 * spoiler protection is off, they've marked it watched, or its 7-day window
 * has ended. Every read model that carries a score, a rank or a price change
 * asks `revealedSessions` first, once per page, and leaves out what's hidden.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { sessionWatchMarks, sessions } from "@/db/schema";
import type { Db } from "@/db/types";

/** How long after a session starts it stays hidden (DM 5.7, decided). */
export const SPOILER_WINDOW_DAYS = 7;
const WINDOW_MS = SPOILER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Who is reading: their id and profile switch, or null for logged out. */
export type Reader = { userId: string; spoilerProtection: boolean } | null;

/**
 * Whether one session is revealed. A session that hasn't started has nothing
 * to hide, so it counts as revealed; from its start it's hidden until it's
 * watched or the window ends.
 */
export function isRevealed(input: {
  sessionStart: Date;
  now: Date;
  watched: boolean;
  protection: boolean;
}): boolean {
  const { sessionStart, now, watched, protection } = input;
  if (!protection || watched) return true;
  const start = sessionStart.getTime();
  return now.getTime() < start || now.getTime() >= start + WINDOW_MS;
}

/**
 * The ids in `sessionIds` that `reader` may see, in one query. An id that
 * isn't a session is never in the answer. A logged-out reader has
 * protection on and no marks (their browser keeps any reveal, DM 5.7).
 */
export async function revealedSessions(
  db: Db,
  now: Date,
  reader: Reader,
  sessionIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({
      id: sessions.id,
      start: sessions.scheduledStart,
      watched: sql<boolean>`${sessionWatchMarks.userId} is not null`,
    })
    .from(sessions)
    .leftJoin(
      sessionWatchMarks,
      and(
        eq(sessionWatchMarks.sessionId, sessions.id),
        reader ? eq(sessionWatchMarks.userId, reader.userId) : sql`false`,
      ),
    )
    .where(inArray(sessions.id, ids));
  const protection = reader?.spoilerProtection ?? true;
  return new Set(
    rows
      .filter((row) =>
        isRevealed({
          sessionStart: row.start,
          now,
          watched: row.watched,
          protection,
        }),
      )
      .map((row) => row.id),
  );
}

/** Marks sessions watched for a user. Marking one again keeps the first mark. */
export async function markWatched(
  db: Db,
  now: Date,
  input: { userId: string; sessionIds: string[] },
): Promise<void> {
  const ids = [...new Set(input.sessionIds)];
  if (ids.length === 0) return;
  await db
    .insert(sessionWatchMarks)
    .values(
      ids.map((sessionId) => ({
        userId: input.userId,
        sessionId,
        markedAt: now,
      })),
    )
    .onConflictDoNothing();
}
