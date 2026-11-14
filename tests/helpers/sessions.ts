import { circuits, events, seasons, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

const HOUR_MS = 3_600_000;
const KINDS = ["fp1", "fp2", "fp3", "qualifying", "race"] as const;

/**
 * A 2026 season with one event, `2026-monaco`, and one session per start
 * time, in order (fp1, fp2, fp3, qualifying, race), each two hours long.
 * Returns the session ids in the same order.
 */
export async function seedEventSessions(
  db: Db,
  ...starts: Date[]
): Promise<string[]> {
  if (starts.length > KINDS.length) throw new Error("at most five sessions");
  const seasonId = newId();
  await db
    .insert(seasons)
    .values({ id: seasonId, year: 2026, status: "active" });
  const circuitId = newId();
  await db.insert(circuits).values({
    id: circuitId,
    slug: "monaco",
    name: "Circuit de Monaco",
    locality: "Monte-Carlo",
    country: "Monaco",
    latitude: "43.734700",
    longitude: "7.420560",
    timezone: "Europe/Monaco",
  });
  const eventId = newId();
  await db.insert(events).values({
    id: eventId,
    seasonId,
    round: 1,
    slug: "2026-monaco",
    name: "Monaco Grand Prix",
    circuitId,
    format: "standard",
    status: "scheduled",
    lockAt: starts[0] ?? new Date("2026-06-06T14:00:00Z"),
    lockAtSource: "default",
  });
  const ids: string[] = [];
  for (const [i, start] of starts.entries()) {
    const id = newId();
    await db.insert(sessions).values({
      id,
      eventId,
      kind: KINDS[i]!,
      scheduledStart: start,
      startConfirmed: true,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR_MS),
      timeSource: "provider",
      status: "scheduled",
    });
    ids.push(id);
  }
  return ids;
}
