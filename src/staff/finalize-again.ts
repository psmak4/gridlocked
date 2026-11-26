import { and, eq, like } from "drizzle-orm";
import { events, jobs } from "@/db/schema";
import type { Db } from "@/db/types";
import { finalizeHeldKey, type FinalizePayload } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { getSetting } from "@/settings";
import { StaffError } from "./errors";

/**
 * The event a review item is about, for "Check the event again now": its own
 * event, or for a dead finalize check the event in the job's dedupe key
 * (`finalize:<event>:…`, which `job_dead` keeps in its details). Null when
 * the item names none.
 */
export function stuckEventOf(item: {
  kind: string;
  eventId: string | null;
  details: unknown;
}): string | null {
  if (item.kind === "finalize_held") return item.eventId;
  if (item.kind !== "job_dead") return null;
  const d = (item.details ?? {}) as Record<string, unknown>;
  if (d.kind !== "finalize_check" || typeof d.dedupe_key !== "string") {
    return null;
  }
  return /^finalize:([^:]+):/.exec(d.dedupe_key)?.[1] ?? null;
}

/**
 * Queues the event's last finalize check again, due now, for an event whose
 * checks stopped: held past the 14-day window, or a check that failed every
 * retry. It is the next of the held follow-ups (`finalize:<event>:held:<n>`),
 * so if it holds again its own follow-ups carry on from there. Refuses
 * (`invalid`, writing nothing) for an event that is missing or no longer
 * scheduled: a completed or cancelled event has nothing left to check.
 */
export async function checkEventAgain(
  tx: Db,
  now: Date,
  eventId: string,
): Promise<void> {
  const [event] = await tx
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new StaffError("invalid", `no event ${eventId}`);
  if (event.status !== "scheduled") {
    throw new StaffError("invalid", `event ${eventId} is ${event.status}`);
  }
  const prefix = finalizeHeldKey(eventId, 0).replace(/0$/, "");
  const held = await tx
    .select({ key: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(eq(jobs.kind, "finalize_check"), like(jobs.dedupeKey, `${prefix}%`)),
    );
  const n =
    Math.max(0, ...held.map((j) => Number(j.key.slice(prefix.length)) || 0)) +
    1;
  const { afterHours } = await getSetting(tx, "finalizer_checks");
  const payload: FinalizePayload = {
    eventId,
    afterHours: Math.max(...afterHours),
    final: true,
    held: n,
  };
  await enqueue(tx, {
    kind: "finalize_check",
    dedupeKey: finalizeHeldKey(eventId, n),
    runAt: now,
    payload,
  });
}
