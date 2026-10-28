import { eq } from "drizzle-orm";
import { events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { PipelineSession } from "./ports";

/** A session with the parts of it and its event the handlers decide on. */
export interface SessionInfo extends PipelineSession {
  scheduledEnd: Date;
  /** True when the session or its event is cancelled: nothing to do. */
  cancelled: boolean;
}

export async function loadSession(
  db: Db,
  sessionId: string,
): Promise<SessionInfo> {
  const [row] = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      eventId: sessions.eventId,
      seasonId: events.seasonId,
      scheduledEnd: sessions.scheduledEnd,
      sessionStatus: sessions.status,
      eventStatus: events.status,
    })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(eq(sessions.id, sessionId));
  if (!row) throw new Error(`no session ${sessionId}`);
  const { sessionStatus, eventStatus, ...rest } = row;
  return {
    ...rest,
    cancelled: sessionStatus === "cancelled" || eventStatus === "cancelled",
  };
}
