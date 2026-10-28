import { eq } from "drizzle-orm";
import { events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { SessionKind } from "./types";

export interface SessionContext {
  kind: SessionKind;
  eventId: string;
  seasonId: string;
}

/** What a session is, and where it sits (its event and season). */
export async function getSessionContext(
  db: Db,
  sessionId: string,
): Promise<SessionContext> {
  const [row] = await db
    .select({
      kind: sessions.kind,
      eventId: sessions.eventId,
      seasonId: events.seasonId,
    })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(eq(sessions.id, sessionId));
  if (!row) throw new Error(`no session ${sessionId}`);
  return row;
}
