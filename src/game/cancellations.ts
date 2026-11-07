import { and, eq } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  events,
  gameEvents,
  gameSessionExceptions,
  type SESSION_EXCEPTION_POLICIES,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SYSTEM_USER_ID } from "@/identity/system";
import { audit, requireReason, type StaffActor } from "@/staff/roster";
import { enqueueScoring } from "./score-jobs";

// Abandoned sessions (DM 3.3, 3.9): a session the game doesn't score as
// normal, such as a race abandoned with a classification that the admins
// decide to void. By default the game scores it as classified (the ruleset's
// `abandonedSessions`). Setting and clearing an exception are staff actions,
// audited in the same transaction, which also queues the session's re-score
// (`enqueueScoring`, keyed by the audit row) for a session already scored.
// Cancelled events are the calendar's, and `planGameEvents` handles them.
// Reads reference data, never writes it (DM 0.5).

type SessionExceptionPolicy = (typeof SESSION_EXCEPTION_POLICIES)[number];

/** The session, if it belongs to an event of the game. */
async function checkGameSession(
  db: Db,
  input: { gameId: string; sessionId: string },
): Promise<void> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .innerJoin(
      gameEvents,
      and(
        eq(gameEvents.eventId, events.id),
        eq(gameEvents.gameId, input.gameId),
      ),
    )
    .where(eq(sessions.id, input.sessionId));
  if (!row) {
    throw new Error(
      `session ${input.sessionId} is not a session of game ${input.gameId}`,
    );
  }
}

/**
 * Sets a session's exception for a game: with `skip`, the game doesn't score
 * the session, and the session is re-scored if it had results. Refuses, writing nothing: a blank reason, a session that isn't
 * one of the game's, and a session that already has an exception (one per
 * session per game; clear it first).
 */
export async function setSessionException(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    sessionId: string;
    policy: SessionExceptionPolicy;
    reason: string;
    actor: StaffActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  const meta = audit(input.actor, reason);
  const { gameId, sessionId, policy } = input;
  await db.transaction(async (tx) => {
    await checkGameSession(tx, { gameId, sessionId });
    const [existing] = await tx
      .select({ policy: gameSessionExceptions.policy })
      .from(gameSessionExceptions)
      .where(
        and(
          eq(gameSessionExceptions.gameId, gameId),
          eq(gameSessionExceptions.sessionId, sessionId),
        ),
      );
    if (existing) {
      throw new Error(
        `session ${sessionId} already has a ${existing.policy} exception in game ${gameId}`,
      );
    }
    // The key refuses a second one set at the same moment.
    await tx.insert(gameSessionExceptions).values({
      gameId,
      sessionId,
      policy,
      reason,
      decidedBy: SYSTEM_USER_ID,
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const auditId = await writeAudit(tx, now, {
      ...meta,
      action: "game_session_exception.set",
      entityType: "game_session_exception",
      entityId: sessionId,
      before: null,
      after: { gameId, policy },
    });
    await enqueueScoring(tx, now, {
      sessionId,
      stamp: `x:${auditId}`,
      trigger: "exception",
      gameId,
    });
  });
}

/**
 * Clears a session's exception for a game, so the game scores the session as
 * normal again, re-scoring it if it had results. The row goes; the audit keeps what it said. Refuses, writing
 * nothing: a blank reason, and a session with no exception.
 */
export async function clearSessionException(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    sessionId: string;
    reason: string;
    actor: StaffActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  const meta = audit(input.actor, reason);
  const { gameId, sessionId } = input;
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(gameSessionExceptions)
      .where(
        and(
          eq(gameSessionExceptions.gameId, gameId),
          eq(gameSessionExceptions.sessionId, sessionId),
        ),
      )
      .returning();
    if (!removed) {
      throw new Error(
        `session ${sessionId} has no exception in game ${gameId}`,
      );
    }
    const auditId = await writeAudit(tx, now, {
      ...meta,
      action: "game_session_exception.clear",
      entityType: "game_session_exception",
      entityId: sessionId,
      before: { gameId, policy: removed.policy, reason: removed.reason },
      after: null,
    });
    await enqueueScoring(tx, now, {
      sessionId,
      stamp: `x:${auditId}`,
      trigger: "exception",
      gameId,
    });
  });
}
