/**
 * The review queue (M8 Task 10, wave 5's review board): every item a human
 * must decide, with what was found, the evidence, what it holds up, and the
 * actions its kind offers (`REVIEW_KINDS`). A resolve claims the item at the
 * version the screen read (`resolveVersioned`) and runs the action in the
 * same transaction, so an action that refuses leaves the item open, and two
 * staff at once can't both act. Resolving a blocking item moves its session
 * on (`advanceStatus`), which queues its scoring.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  auditLog,
  constructors,
  drivers,
  events,
  reviewItems,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { enqueueScoring } from "@/game/score-jobs";
import { type DueStore, republishIfEarlier } from "@/jobs/due-times";
import type { TickDb } from "@/jobs/tick";
import { SESSION_LABELS } from "@/play/weekend";
import { advanceStatus } from "@/results/status";
import { SCORED_KINDS } from "@/results/validate";
import type { SessionKind } from "@/results/types";
import { StaffError } from "./errors";
import {
  reviewKindSpec,
  type ReviewItemRow,
  type ReviewView,
} from "./review-kinds";
import { audit, requireReason, type StaffActor } from "./roster";
import { resolveVersioned } from "./versioned";

export type ReviewListItem = {
  id: string;
  kind: string;
  severity: "warning" | "blocking";
  status: "open" | "resolved" | "dismissed";
  title: string;
  summary: string;
  event: { id: string; round: number; name: string } | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** The action taken ("Mark unavailable", "Dismiss", or an automatic one). */
  resolution: string | null;
  /** The reason the resolver gave, from the audit log. */
  reason: string | null;
};

export type ReviewDetail = ReviewListItem & {
  version: number;
  evidence: [string, string][];
  /** "Scoring is held for Dutch GP qualifying and the race", or null. */
  held: string | null;
  actions: { id: string; label: string; href: string | null }[];
};

/** How many done items the Resolved tab shows. */
const DONE_PAGE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id in the items' details and driver column. */
function idsIn(items: ReviewItemRow[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.driverId) ids.add(item.driverId);
    if (item.details && typeof item.details === "object") {
      for (const value of Object.values(item.details)) {
        if (typeof value === "string" && UUID.test(value)) ids.add(value);
      }
    }
  }
  return [...ids];
}

/** The names the ids stand for: drivers, constructors and events. */
async function namesFor(
  db: Db,
  ids: string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const names: Record<string, string> = {};
  for (const d of await db
    .select({
      id: drivers.id,
      displayName: drivers.displayName,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
    })
    .from(drivers)
    .where(inArray(drivers.id, ids))) {
    names[d.id] = d.displayName ?? `${d.givenName} ${d.familyName}`;
  }
  for (const c of await db
    .select({ id: constructors.id, name: constructors.name })
    .from(constructors)
    .where(inArray(constructors.id, ids))) {
    names[c.id] = c.name;
  }
  for (const e of await db
    .select({ id: events.id, name: events.name })
    .from(events)
    .where(inArray(events.id, ids))) {
    names[e.id] = e.name;
  }
  return names;
}

type Context = {
  names: Record<string, string>;
  events: Map<string, { id: string; round: number; name: string }>;
  sessions: Map<string, { id: string; kind: string; label: string }>;
  reasons: Map<string, string>;
};

async function contextFor(db: Db, items: ReviewItemRow[]): Promise<Context> {
  const eventIds = [
    ...new Set(items.flatMap((i) => (i.eventId ? [i.eventId] : []))),
  ];
  const sessionIds = [
    ...new Set(items.flatMap((i) => (i.sessionId ? [i.sessionId] : []))),
  ];
  const doneIds = items.filter((i) => i.status !== "open").map((i) => i.id);
  const eventRows =
    eventIds.length === 0
      ? []
      : await db
          .select({ id: events.id, round: events.round, name: events.name })
          .from(events)
          .where(inArray(events.id, eventIds));
  const sessionRows =
    sessionIds.length === 0
      ? []
      : await db
          .select({ id: sessions.id, kind: sessions.kind })
          .from(sessions)
          .where(inArray(sessions.id, sessionIds));
  const reasonRows =
    doneIds.length === 0
      ? []
      : await db
          .select({ entityId: auditLog.entityId, reason: auditLog.reason })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.entityType, "review_item"),
              inArray(auditLog.entityId, doneIds),
            ),
          )
          .orderBy(asc(auditLog.createdAt));
  return {
    names: await namesFor(db, idsIn(items)),
    events: new Map(eventRows.map((e) => [e.id, e])),
    sessions: new Map(
      sessionRows.map((s) => [
        s.id,
        { ...s, label: SESSION_LABELS[s.kind as SessionKind] },
      ]),
    ),
    reasons: new Map(
      reasonRows.flatMap((r) =>
        r.entityId && r.reason ? [[r.entityId, r.reason] as const] : [],
      ),
    ),
  };
}

function viewOf(item: ReviewItemRow, ctx: Context): ReviewView {
  return {
    item,
    names: ctx.names,
    event: item.eventId ? (ctx.events.get(item.eventId) ?? null) : null,
    session: item.sessionId ? (ctx.sessions.get(item.sessionId) ?? null) : null,
  };
}

function listItem(item: ReviewItemRow, ctx: Context): ReviewListItem {
  const view = viewOf(item, ctx);
  const spec = reviewKindSpec(item.kind);
  return {
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    status: item.status,
    title: spec.title(view),
    summary: spec.summary(view),
    event: view.event,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    reason: ctx.reasons.get(item.id) ?? null,
  };
}

/**
 * The Open tab (blocking first, then newest) or the Resolved tab (resolved
 * and dismissed, newest first, 50).
 */
export async function reviewList(
  db: Db,
  { status }: { status: "open" | "resolved" },
): Promise<ReviewListItem[]> {
  const items =
    status === "open"
      ? await db
          .select()
          .from(reviewItems)
          .where(eq(reviewItems.status, "open"))
          .orderBy(
            sql`case when ${reviewItems.severity} = 'blocking' then 0 else 1 end`,
            desc(reviewItems.createdAt),
            desc(reviewItems.id),
          )
      : await db
          .select()
          .from(reviewItems)
          .where(inArray(reviewItems.status, ["resolved", "dismissed"]))
          .orderBy(desc(reviewItems.resolvedAt), desc(reviewItems.id))
          .limit(DONE_PAGE);
  const ctx = await contextFor(db, items);
  return items.map((item) => listItem(item, ctx));
}

/** How many items are open: the menu's count. */
export async function openReviewCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::integer` })
    .from(reviewItems)
    .where(eq(reviewItems.status, "open"));
  return row?.n ?? 0;
}

/** "Australian GP" for "Australian Grand Prix". */
const short = (name: string) => name.replace(/ Grand Prix$/, " GP");

/** "qualifying", "qualifying and the race", "sprint, qualifying and the race". */
function heldWords(kinds: string[]): string {
  const words = kinds.map((kind) => {
    const label = SESSION_LABELS[kind as SessionKind].toLowerCase();
    return kinds.length > 1 && (kind === "race" || kind === "sprint")
      ? `the ${label}`
      : label;
  });
  return words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What the item holds up: the sessions of its event that open blocking items
 * hold, in session order. Null for a warning, and for an item that holds no
 * session.
 */
async function heldLine(db: Db, item: ReviewItemRow): Promise<string | null> {
  if (item.status !== "open" || item.severity !== "blocking" || !item.eventId) {
    return null;
  }
  const held = await db
    .selectDistinct({
      kind: sessions.kind,
      start: sessions.scheduledStart,
      name: events.name,
    })
    .from(reviewItems)
    .innerJoin(sessions, eq(sessions.id, reviewItems.sessionId))
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(
      and(
        eq(reviewItems.eventId, item.eventId),
        eq(reviewItems.status, "open"),
        eq(reviewItems.severity, "blocking"),
      ),
    )
    .orderBy(asc(sessions.scheduledStart));
  if (held.length === 0) return null;
  return `Scoring is held for ${short(held[0]!.name)} ${heldWords(held.map((h) => h.kind))}`;
}

/** One item with its evidence, what it holds, and its actions. */
export async function reviewItem(
  db: Db,
  id: string,
): Promise<ReviewDetail | null> {
  const [item] = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.id, id));
  if (!item) return null;
  const ctx = await contextFor(db, [item]);
  const view = viewOf(item, ctx);
  const spec = reviewKindSpec(item.kind);
  return {
    ...listItem(item, ctx),
    version: item.version,
    evidence: spec.evidence(view),
    held: await heldLine(db, item),
    actions: spec.actions.flatMap((action) => {
      if (action.when && !action.when(item)) return [];
      const href = action.href ? action.href(item) : null;
      if (action.href && !href) return [];
      return [{ id: action.id, label: action.label, href }];
    }),
  };
}

/**
 * Resolves an item with one of its kind's actions, at the version the screen
 * read: Dismiss closes it as `dismissed`, an action with `run` does its work
 * and closes it as `resolved`, in one transaction with the audit rows. Then a
 * blocking item's session moves on. Refuses, writing nothing: a blank reason,
 * an item that isn't there (`not_found`), a link or an action its kind
 * doesn't have (`invalid`), an item someone else got to first (`stale`), and
 * whatever the action itself refuses (`event_locked`, …).
 *
 * With `store`, the due-times file is republished afterwards if the work the
 * resolve queued (a check, a scoring run) is due before what it says, so the
 * tick picks it up at its next minute rather than at the next wake.
 */
export async function resolveReviewItem(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { id: string; version: number; actionId: string; reason: string },
  store?: DueStore,
): Promise<{ status: "resolved" | "dismissed" }> {
  const reason = requireReason(input.reason);
  const result = await resolveInTransaction(db, now, actor, input, reason);
  if (store) await republishIfEarlier(db as TickDb, store, now, now);
  return result;
}

function resolveInTransaction(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { id: string; version: number; actionId: string },
  reason: string,
): Promise<{ status: "resolved" | "dismissed" }> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, input.id));
    if (!item) throw new StaffError("not_found", `no review item ${input.id}`);
    const action = reviewKindSpec(item.kind).actions.find(
      (a) => a.id === input.actionId,
    );
    if (
      !action ||
      (!action.run && action.id !== "dismiss") ||
      (action.when && !action.when(item))
    ) {
      throw new StaffError(
        "invalid",
        `${item.kind} has no action ${input.actionId}`,
      );
    }
    const status = action.run ? "resolved" : "dismissed";
    const claimed = await resolveVersioned(tx, reviewItems, input, {
      status,
      resolution: action.label,
      resolvedBy: actor.userId ?? null,
      resolvedAt: now,
    });
    if (!claimed) throw new StaffError("stale", `review item ${item.id}`);

    if (action.run) await action.run(tx, now, actor, item, reason);
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action:
        status === "resolved" ? "review_item.resolve" : "review_item.dismiss",
      entityType: "review_item",
      entityId: item.id,
      before: { status: "open", kind: item.kind },
      after: { status, action: action.id },
    });

    if (
      item.severity === "blocking" &&
      item.sessionId &&
      (await isScored(tx, item.sessionId))
    ) {
      const advance = await advanceStatus(tx, now, item.sessionId);
      await enqueueScoring(tx, now, {
        sessionId: item.sessionId,
        stamp: `v${advance.resultsVersion}`,
        trigger: "override",
      });
    }
    return { status };
  });
}

async function isScored(tx: Db, sessionId: string): Promise<boolean> {
  const [session] = await tx
    .select({ kind: sessions.kind })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return !!session && SCORED_KINDS.includes(session.kind as SessionKind);
}
