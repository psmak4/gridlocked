/**
 * Session threads (HLD §7.2, DM 5.3): one per session, opened by the
 * `open_threads` job on the Monday of the event's week. Each is live chat
 * from 15 minutes before its session to 15 minutes after, and a discussion
 * otherwise; once the session's results are scored the system account posts
 * a link to them, inside the session's spoiler scope, in the transaction
 * that publishes the run's totals.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  categories,
  drivers,
  effectiveResults,
  events,
  posts,
  sessions,
  threads,
  SESSION_STATUSES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SYSTEM_USER_ID } from "@/identity/system";
import { openThreadsPayload } from "@/jobs/kinds";
import type { JobHandler } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { SESSION_LABELS } from "@/play/weekend";
import { broadcast } from "@/notifications/write";
import { pathLabel } from "./mentions";
import { hotRank } from "./upkeep";

type SessionStatus = (typeof SESSION_STATUSES)[number];

const MINUTE_MS = 60_000;

/** Chat opens this long before a session starts and closes this long after it ends. */
export const CHAT_MARGIN_MS = 15 * MINUTE_MS;

/** Where session threads live. */
const RACE_WEEKEND = "race-weekend";

/**
 * How long past its window a session's chat waits for the results post: a
 * long red flag runs a race past its scheduled end before staff mark it
 * `suspended` (the Calendar screen, M8), and a suspended session's chat stays
 * live past its end on its own (M7's review, I5).
 */
export const RESULTS_WAIT_MS = 60 * MINUTE_MS;

/** True while a thread has no results post (the system account's reply). */
export const awaitingResultsSql = sql<boolean>`not exists (select 1 from ${posts} where ${posts.threadId} = ${threads.id} and ${posts.authorUserId} = ${SYSTEM_USER_ID} and not ${posts.isOpening})`;

/** The results post's text: a link, so it gives nothing away itself. */
export const RESULTS_POST_BODY =
  "Results are in: [Results and points](/weekend)";

/** −15 minutes from the start to +15 from the end (HLD §7.2). Pure. */
export function chatWindow(session: {
  scheduledStart: Date;
  scheduledEnd: Date;
}): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(session.scheduledStart.getTime() - CHAT_MARGIN_MS),
    closesAt: new Date(session.scheduledEnd.getTime() + CHAT_MARGIN_MS),
  };
}

/**
 * Chat or discussion, from the clock and the session (DM 5.3: never
 * stored). Chat inside the window, and past it while the session is
 * suspended (a red flag) or, for up to `RESULTS_WAIT_MS`, while its thread
 * waits for the results post; discussion otherwise, and always for a
 * cancelled session or a thread with no window, and whenever staff have
 * turned chat off (`feature_flags.chat`, M8 Task 13). Pure.
 */
export function threadMode(
  now: Date,
  session: { status: SessionStatus; awaitingResults?: boolean } | null,
  thread: { chatOpensAt: Date | null; chatClosesAt: Date | null },
  chatOn = true,
): "chat" | "discussion" {
  const { chatOpensAt, chatClosesAt } = thread;
  if (!chatOn) return "discussion";
  if (!chatOpensAt || !chatClosesAt) return "discussion";
  if (session?.status === "cancelled") return "discussion";
  if (now < chatOpensAt) return "discussion";
  if (now < chatClosesAt) return "chat";
  if (session?.status === "suspended") return "chat";
  return session?.awaitingResults &&
    now.getTime() < chatClosesAt.getTime() + RESULTS_WAIT_MS
    ? "chat"
    : "discussion";
}

/** "Monaco GP" for "Monaco Grand Prix", as wave 4's rows say it. */
export const shortEvent = (name: string) =>
  name.replace(/\bGrand Prix\b/, "GP");

/** The Monday 00:00 UTC of the week `at` falls in. */
export function mondayOf(at: Date): Date {
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() - daysSinceMonday,
    ),
  );
}

/**
 * A thread for each of the event's sessions that has none, with its opening
 * post from the system account. Idempotent: a session that has a thread is
 * skipped, so running it again (or after a session is added) adds only what
 * is missing. A cancelled event or session gets nothing.
 */
export async function openSessionThreads(
  db: Db,
  now: Date,
  eventId: string,
): Promise<number> {
  const [event] = await db
    .select({ name: events.name, status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event || event.status === "cancelled") return 0;
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, RACE_WEEKEND));
  if (!category)
    throw new Error("openSessionThreads: no race-weekend category");

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Two runs at once would both see no thread; the lock makes the second
    // wait for the first and then find its threads.
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`open_threads:${eventId}`}, 0))`,
    );
    const planned = await t
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.eventId, eventId), ne(sessions.status, "cancelled")),
      )
      .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
    if (planned.length === 0) return 0;
    const existing = new Set(
      (
        await t
          .select({ sessionId: threads.sessionId })
          .from(threads)
          .where(
            and(
              eq(threads.kind, "session"),
              inArray(
                threads.sessionId,
                planned.map((s) => s.id),
              ),
            ),
          )
      ).map((r) => r.sessionId),
    );

    let opened = 0;
    for (const session of planned) {
      if (existing.has(session.id)) continue;
      const label = SESSION_LABELS[session.kind];
      const title = `${shortEvent(event.name)} · ${label}`;
      const { opensAt, closesAt } = chatWindow(session);
      const threadId = newId();
      const postId = newId();
      await t.insert(threads).values({
        id: threadId,
        categoryId: category.id,
        kind: "session",
        title,
        // The title names no result, so it is its own safe title.
        spoilerSafeTitle: title,
        containsSpoilers: true,
        authorUserId: null,
        sessionId: session.id,
        eventId,
        chatOpensAt: opensAt,
        chatClosesAt: closesAt,
        hotRank: hotRank(0, now),
        lastActivityAt: now,
        createdAt: now,
      });
      await t.insert(posts).values({
        id: postId,
        threadId,
        path: pathLabel(postId),
        depth: 0,
        isOpening: true,
        authorUserId: SYSTEM_USER_ID,
        body: `${label} at the ${event.name}. Live chat opens 15 minutes before the start; after the session, this is its discussion.`,
        sessionId: session.id,
        containsSpoilers: true,
        status: "visible",
        createdAt: now,
      });
      opened++;
    }
    return opened;
  });
}

/**
 * Moves a session's thread's chat window with the session. Call it in the
 * transaction that moves the session, so the two never disagree.
 */
export async function moveChatWindow(
  db: Db,
  session: { id: string; scheduledStart: Date; scheduledEnd: Date },
): Promise<void> {
  const { opensAt, closesAt } = chatWindow(session);
  await db
    .update(threads)
    .set({ chatOpensAt: opensAt, chatClosesAt: closesAt })
    .where(and(eq(threads.sessionId, session.id), eq(threads.kind, "session")));
}

/**
 * The system account's results post in a session's thread: a link to the
 * results, inside the session's spoiler scope. Once per session: a second
 * call, or a re-score, adds nothing. Skipped for a cancelled session, and
 * for one with no thread.
 */
export async function postResults(
  db: Db,
  now: Date,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ status: sessions.status, threadId: threads.id })
    .from(sessions)
    .innerJoin(
      threads,
      and(eq(threads.sessionId, sessions.id), eq(threads.kind, "session")),
    )
    .where(eq(sessions.id, sessionId));
  if (!row || row.status === "cancelled") return false;

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // The thread row's lock orders two posters; the second finds the first's post.
    await t
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, row.threadId))
      .for("update");
    const [already] = await t
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.threadId, row.threadId),
          eq(posts.authorUserId, SYSTEM_USER_ID),
          eq(posts.isOpening, false),
        ),
      )
      .limit(1);
    if (already) return false;
    const postId = newId();
    await t.insert(posts).values({
      id: postId,
      threadId: row.threadId,
      path: pathLabel(postId),
      depth: 1,
      isOpening: false,
      authorUserId: SYSTEM_USER_ID,
      body: RESULTS_POST_BODY,
      sessionId,
      containsSpoilers: true,
      status: "visible",
      createdAt: now,
    });
    await t
      .update(threads)
      .set({
        replyCount: sql`${threads.replyCount} + 1`,
        lastActivityAt: now,
      })
      .where(eq(threads.id, row.threadId));
    await broadcastScores(t, now, sessionId);
    return true;
  });
}

/** Sessions whose winner (or pole-sitter) "Scores are in" names. */
const LED: ReadonlySet<string> = new Set([
  "qualifying",
  "sprint_qualifying",
  "sprint",
  "race",
]);

/**
 * "Scores are in" for everyone, once per session (wave 4: SCORES). The
 * leader's name is stored, but shown only to readers who revealed the session.
 */
async function broadcastScores(
  db: Db,
  now: Date,
  sessionId: string,
): Promise<void> {
  const [session] = await db
    .select({ kind: sessions.kind, eventId: events.id, event: events.name })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(eq(sessions.id, sessionId));
  if (!session) return;
  let leader: string | null = null;
  if (LED.has(session.kind)) {
    const [first] = await db
      .select({ given: drivers.givenName, family: drivers.familyName })
      .from(effectiveResults)
      .innerJoin(drivers, eq(drivers.id, effectiveResults.driverId))
      .where(
        and(
          eq(effectiveResults.sessionId, sessionId),
          eq(effectiveResults.position, 1),
        ),
      )
      .limit(1);
    leader = first ? `${first.given} ${first.family}` : null;
  }
  await broadcast(db, now, {
    kind: "scores_in",
    sessionId,
    eventId: session.eventId,
    dedupeKey: `scores_in:${sessionId}`,
    data: {
      event: session.event,
      session: SESSION_LABELS[session.kind],
      sessionKind: session.kind,
      leader,
    },
  });
}

/** `open_threads`: the event's session threads (planned by `planEventJobs`). */
export function createOpenThreadsHandler(): JobHandler {
  return async (job, ctx) => {
    const { eventId } = openThreadsPayload.parse(job.payload);
    await openSessionThreads(ctx.db as Db, ctx.clock.now(), eventId);
  };
}
