/**
 * What the forum's screens need to know about the viewer, and what "New
 * thread" needs besides: the categories they can start in, and the session
 * a Race Weekend title would spoil (HLD §7.3's soft check runs in the
 * browser as they type, and again on the server).
 */
import { and, asc, desc, eq, gt, lte, ne } from "drizzle-orm";
import { categories, events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { canPost, type Viewer } from "@/identity/viewer";
import { SESSION_LABELS } from "@/play/weekend";
import { SPOILER_WINDOW_DAYS } from "@/spoilers/reveal";
import { effectiveLevel, spoilerNames } from "./gate";
import { sessionPhrase } from "./read";
import { canStartIn, type Writer } from "./writer";

export type { Writer };

export function writerOf(viewer: Viewer | null): Writer {
  if (!viewer) return null;
  let posting = true;
  try {
    canPost(viewer);
  } catch {
    posting = false;
  }
  return {
    trustLevel: effectiveLevel(viewer, viewer.profile.trustLevel),
    canPost: posting,
  };
}

export type SpoilerSession = {
  id: string;
  /** "Qualifying" */
  label: string;
  /** "qualifying", "the race": for "Contains spoilers for …". */
  phrase: string;
  eventName: string;
};

export type ComposerData = {
  categories: { id: string; slug: string; name: string; kind: string }[];
  spoilerSession: SpoilerSession | null;
  spoilerNames: { driverNames: string[]; teamNames: string[] };
};

/**
 * The session a result in a title would come from: the latest one that has
 * started and is still inside its spoiler window.
 */
async function spoilerSession(
  db: Db,
  now: Date,
): Promise<SpoilerSession | null> {
  const since = new Date(
    now.getTime() - SPOILER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [row] = await db
    .select({ id: sessions.id, kind: sessions.kind, eventName: events.name })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(
      and(
        lte(sessions.scheduledStart, now),
        gt(sessions.scheduledStart, since),
        ne(sessions.status, "cancelled"),
      ),
    )
    .orderBy(desc(sessions.scheduledStart))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    label: SESSION_LABELS[row.kind],
    phrase: sessionPhrase(row.kind),
    eventName: row.eventName,
  };
}

/** "New thread": where the viewer can start one, and the spoiler check's facts. */
export async function composerData(
  db: Db,
  now: Date,
  writer: Writer,
): Promise<ComposerData> {
  const rows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      kind: categories.kind,
      minTrust: categories.minTrustToStartThread,
    })
    .from(categories)
    .where(eq(categories.status, "active"))
    .orderBy(asc(categories.position));
  const [session, names] = await Promise.all([
    spoilerSession(db, now),
    spoilerNames(db),
  ]);
  return {
    categories: rows
      .filter((c) => canStartIn(writer, c.minTrust))
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name, kind: c.kind })),
    spoilerSession: session,
    spoilerNames: names,
  };
}
