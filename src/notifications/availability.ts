/**
 * The availability notice (M8 Task 6, wave 4's YOUR TEAM line): "<driver> is
 * out for the <event>. Check <team>." to each person whose team has the
 * driver in the lineup that would count for the event, once per person
 * however many of their teams have him, plus push for those with it on. It
 * is about a coming event, so it carries no result and no session: nothing
 * in it is a spoiler. A second change before it's read counts into it.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  drivers,
  events,
  gameEvents,
  games,
  poolAssets,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { lockedLineups } from "@/game/lineups";
import { notify } from "./write";

export type AvailabilityStatus =
  "available" | "doubtful" | "unavailable" | "reserve";

/**
 * The people whose lineup for the event has the driver, each with their
 * first team that does (lowest slot), in every running game where the event
 * hasn't locked.
 */
export async function availabilityOwners(
  db: Db,
  input: { eventId: string; driverId: string },
): Promise<{ userId: string; teamId: string; teamName: string }[]> {
  const gameRows = await db
    .select({ id: games.id })
    .from(gameEvents)
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(gameEvents.eventId, input.eventId),
        inArray(gameEvents.status, ["upcoming", "open"]),
        inArray(games.status, ["open", "running"]),
      ),
    )
    .orderBy(asc(games.id));
  const owners = new Map<string, { teamId: string; teamName: string }>();
  for (const { id: gameId } of gameRows) {
    const assets = new Set(
      (
        await db
          .select({ id: poolAssets.id })
          .from(poolAssets)
          .where(
            and(
              eq(poolAssets.gameId, gameId),
              eq(poolAssets.driverId, input.driverId),
            ),
          )
      ).map((a) => a.id),
    );
    if (assets.size === 0) continue;
    const gameTeams = await db
      .select({ id: teams.id, userId: teams.userId, name: teams.name })
      .from(teams)
      .where(and(eq(teams.gameId, gameId), eq(teams.status, "active")))
      .orderBy(asc(teams.userId), asc(teams.slot));
    const lineups = await lockedLineups(db, {
      eventId: input.eventId,
      teamIds: gameTeams.map((tm) => tm.id),
    });
    for (const team of gameTeams) {
      if (owners.has(team.userId)) continue;
      const picks = lineups.get(team.id)?.picks ?? [];
      if (picks.some((p) => assets.has(p.assetId))) {
        owners.set(team.userId, { teamId: team.id, teamName: team.name });
      }
    }
  }
  return [...owners].map(([userId, o]) => ({ userId, ...o }));
}

/** Notifies the driver's owners for the event. Returns how many people own him. */
export async function notifyAvailability(
  db: Db,
  now: Date,
  input: { eventId: string; driverId: string; status: AvailabilityStatus },
): Promise<number> {
  const [about] = await db
    .select({
      event: events.name,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(events)
    .innerJoin(drivers, eq(drivers.id, input.driverId))
    .where(eq(events.id, input.eventId));
  if (!about) return 0;
  const owners = await availabilityOwners(db, input);
  for (const owner of owners) {
    await notify(db, now, {
      userId: owner.userId,
      kind: "roster_change",
      groupKey: `availability:${input.eventId}:${input.driverId}`,
      refs: { eventId: input.eventId, teamId: owner.teamId },
      data: {
        driver: about.displayName ?? about.familyName,
        status: input.status,
        event: about.event,
        team: owner.teamName,
      },
    });
  }
  return owners.length;
}
