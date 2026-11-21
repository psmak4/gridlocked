/**
 * Every kind of review item the app opens (M8 Task 10, DM 2.9), with the
 * words the queue shows and the actions it offers. The board's five (team
 * change, missing driver, event missing from the provider, uncertain event
 * match, sources disagree) have its copy and actions; the rest get a plain
 * title, their details as evidence, a "Go to …" link where a screen fixes it,
 * and Dismiss. `openReviewItem` takes only these kinds, so a new one without
 * words doesn't compile.
 *
 * An action with `run` changes something and resolves the item, in the one
 * transaction `resolveReviewItem` opens after claiming it; an action with
 * `href` is a link and resolves nothing; Dismiss closes the item as is.
 */
import { desc, eq, and } from "drizzle-orm";
import { seatAssignments, type reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { setAvailability } from "./availability";
import { cancelEvent } from "./calendar";
import { StaffError } from "./errors";
import { changeSeats, type StaffActor } from "./roster";

export type ReviewItemRow = typeof reviewItems.$inferSelect;

/** What the words are made from: the item, and the names its ids stand for. */
export type ReviewView = {
  item: Pick<
    ReviewItemRow,
    "id" | "kind" | "severity" | "eventId" | "sessionId" | "driverId"
  > & { details: unknown };
  /** Driver, constructor and event names by id. */
  names: Record<string, string>;
  event: { id: string; round: number; name: string } | null;
  session: { id: string; kind: string; label: string } | null;
};

export type ReviewAction = {
  id: string;
  label: string;
  /** A "Go to …" link: where it goes for this item, or null to leave it out. */
  href?: (item: ReviewView["item"]) => string | null;
  run?: (
    tx: Db,
    now: Date,
    actor: StaffActor,
    item: ReviewItemRow,
    reason: string,
  ) => Promise<void>;
};

export type ReviewKindSpec = {
  title: (view: ReviewView) => string;
  summary: (view: ReviewView) => string;
  evidence: (view: ReviewView) => [label: string, value: string][];
  actions: ReviewAction[];
};

// --- Helpers ------------------------------------------------------------------

const details = (view: ReviewView): Record<string, unknown> =>
  view.item.details !== null && typeof view.item.details === "object"
    ? (view.item.details as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The name an id in the details stands for, or `fallback`. */
function named(view: ReviewView, key: string, fallback: string): string {
  const id =
    text(details(view)[key]) ??
    (key === "driverId" ? view.item.driverId : null);
  return (id && view.names[id]) || fallback;
}
const eventName = (view: ReviewView) => view.event?.name ?? "the event";
const sessionName = (view: ReviewView) =>
  view.session
    ? `${eventName(view)} ${view.session.label.toLowerCase()}`
    : eventName(view);

/** "driverId" → "Driver", "scheduled_end" → "Scheduled end". */
function labelOf(key: string): string {
  const words = key
    .replace(/Id$/, "")
    .replace(/_id$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const HIDDEN = new Set(["snapshotId"]);

/** Every detail but the snapshot, ids as names. */
function plainEvidence(view: ReviewView): [string, string][] {
  return Object.entries(details(view))
    .filter(([key, value]) => !HIDDEN.has(key) && value !== null)
    .map(([key, value]) => [
      labelOf(key),
      typeof value === "string"
        ? (view.names[value] ?? value)
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value),
    ]);
}

const DISMISS: ReviewAction = { id: "dismiss", label: "Dismiss" };

const goTo = (
  id: string,
  label: string,
  href: ReviewAction["href"] & object,
): ReviewAction => ({ id, label, href });
const GO_SEATS = goTo(
  "go_seats",
  "Go to Drivers and seats",
  () => "/staff/seats",
);
const GO_CALENDAR = goTo(
  "go_calendar",
  "Go to Calendar",
  () => "/staff/calendar",
);
const GO_SCORING = goTo("go_scoring", "Go to Scoring", () => "/staff/scoring");
const GO_PRICES = goTo("go_prices", "Go to Prices", () => "/staff/prices");
const GO_RESULTS = goTo("go_results", "Go to session results", (item) =>
  item.sessionId ? `/staff/results/${item.sessionId}` : null,
);

/** A kind with no screen of its own: a plain title, its details, Dismiss. */
function plain(
  title: string,
  summary: string | ((view: ReviewView) => string),
  links: ReviewAction[] = [],
): ReviewKindSpec {
  return {
    title: () => title,
    summary: typeof summary === "string" ? () => summary : summary,
    evidence: plainEvidence,
    actions: [...links, DISMISS],
  };
}

/** A driver's car number from his latest race seat. */
async function carNumberOf(tx: Db, driverId: string): Promise<number> {
  const [seat] = await tx
    .select({ carNumber: seatAssignments.carNumber })
    .from(seatAssignments)
    .where(
      and(
        eq(seatAssignments.driverId, driverId),
        eq(seatAssignments.role, "race"),
      ),
    )
    .orderBy(desc(seatAssignments.validFrom))
    .limit(1);
  if (!seat) throw new StaffError("invalid", `driver ${driverId} has no seat`);
  return seat.carNumber;
}

function itemDetails(item: ReviewItemRow): Record<string, unknown> {
  return item.details !== null && typeof item.details === "object"
    ? (item.details as Record<string, unknown>)
    : {};
}

// --- The kinds ----------------------------------------------------------------

export const REVIEW_KINDS = {
  // The board's five.
  team_change: {
    title: (v) =>
      `${named(v, "driverId", "A driver")} is at ${named(v, "constructorId", "another team")}`,
    summary: (v) =>
      `${named(v, "driverId", "A driver")} drove for ${named(v, "constructorId", "another team")} at ${eventName(v)}, but the seats say ${named(v, "expectedConstructorId", "another team")}. Update the seats if the move is for good.`,
    evidence: (v) => [
      ["Driver", named(v, "driverId", "—")],
      ["The provider says", named(v, "constructorId", "—")],
      ["Our seats say", named(v, "expectedConstructorId", "no seat")],
      ...(typeof details(v).carNumber === "number"
        ? [["Car", String(details(v).carNumber)] as [string, string]]
        : []),
    ],
    actions: [
      {
        id: "update_seats",
        label: "Update seats from this event on",
        run: async (tx, now, actor, item, reason) => {
          const d = itemDetails(item);
          const driverId = text(d.driverId) ?? item.driverId;
          const constructorId = text(d.constructorId);
          if (!item.eventId || !driverId || !constructorId) {
            throw new StaffError("invalid", "the item names no seat");
          }
          const carNumber =
            typeof d.carNumber === "number"
              ? d.carNumber
              : await carNumberOf(tx, driverId);
          await changeSeats(tx, now, {
            fromEventId: item.eventId,
            changes: [{ driverId, constructorId, carNumber }],
            reason,
            actor,
          });
        },
      },
      GO_SEATS,
      DISMISS,
    ],
  },
  missing_driver: {
    title: (v) => `${named(v, "driverId", "A driver")} is missing`,
    summary: (v) =>
      `${named(v, "driverId", "A driver")} is entered for ${eventName(v)} but isn't in ${v.session ? `the ${v.session.label.toLowerCase()} results` : "the sessions so far"}. Mark him unavailable if he isn't taking part.`,
    evidence: (v) => [
      ["Driver", named(v, "driverId", "—")],
      ...(v.session ? [["Session", sessionName(v)] as [string, string]] : []),
      ...(text(details(v).reason)
        ? [
            ["Found by", String(details(v).reason).replace(/_/g, " ")] as [
              string,
              string,
            ],
          ]
        : []),
    ],
    actions: [
      {
        id: "mark_unavailable",
        label: "Mark unavailable",
        run: async (tx, now, actor, item, reason) => {
          const driverId = text(itemDetails(item).driverId) ?? item.driverId;
          if (!item.eventId || !driverId) {
            throw new StaffError("invalid", "the item names no driver");
          }
          await setAvailability(
            tx,
            now,
            actor,
            {
              eventId: item.eventId,
              driverId,
              status: "unavailable",
              note: "",
              reason,
            },
            { afterLock: true },
          );
        },
      },
      GO_RESULTS,
      DISMISS,
    ],
  },
  event_missing_from_provider: {
    title: (v) => `${eventName(v)} is missing from the provider`,
    summary: (v) =>
      `The provider's calendar no longer lists ${eventName(v)}. Mark it cancelled if it won't run; its chips are refunded.`,
    evidence: (v) => [
      ["Event", v.event ? `Round ${v.event.round} · ${v.event.name}` : "—"],
      ...plainEvidence(v),
    ],
    actions: [
      {
        id: "mark_cancelled",
        label: "Mark cancelled",
        run: async (tx, now, actor, item, reason) => {
          if (!item.eventId) {
            throw new StaffError("invalid", "the item names no event");
          }
          await cancelEvent(tx, now, actor, { eventId: item.eventId, reason });
        },
      },
      GO_CALENDAR,
      DISMISS,
    ],
  },
  uncertain_event_match: {
    title: () => "An event may have moved",
    summary: () =>
      "The provider lists an event we can't match to ours for certain. Check it on the Calendar, then dismiss this.",
    evidence: plainEvidence,
    actions: [GO_CALENDAR, DISMISS],
  },
  provider_after_manual: {
    title: (v) => `Sources disagree on ${sessionName(v)}`,
    summary: () =>
      "The provider's results arrived after results were entered by hand, and they differ. Scoring waits until you decide which stands.",
    evidence: plainEvidence,
    actions: [GO_RESULTS, DISMISS],
  },

  // Results.
  validation_failed: plain(
    "Results failed a check",
    (v) => `${sessionName(v)}'s results failed a check, so scoring waits.`,
    [GO_RESULTS],
  ),
  unknown_driver: plain(
    "A driver the event doesn't list",
    (v) => `The results name a driver ${eventName(v)} doesn't list.`,
    [GO_SEATS, GO_RESULTS],
  ),
  unknown_constructor: plain(
    "A team the event doesn't list",
    (v) => `The results name a team ${eventName(v)} doesn't list.`,
    [GO_SEATS, GO_RESULTS],
  ),
  unknown_classification: plain(
    "A result status we don't know",
    "The provider used a finishing status we can't read, so scoring waits.",
    [GO_RESULTS],
  ),
  results_disappeared: plain(
    "Results disappeared",
    "The provider's answer has fewer results than before. Nothing was removed.",
    [GO_RESULTS],
  ),
  normalize_after_final: plain(
    "New results after the session was final",
    "The provider changed results after the session became final. They weren't applied.",
    [GO_RESULTS],
  ),
  poll_gave_up: plain(
    "No results arrived",
    (v) =>
      `We stopped waiting for ${sessionName(v)}'s results. Enter them by hand, or dismiss this if they've come in.`,
    [GO_RESULTS],
  ),
  finalize_held: plain(
    "Finalizing is held",
    (v) => `${eventName(v)} can't become final while items are open.`,
    [GO_CALENDAR],
  ),

  // Scoring and prices.
  score_mismatch: plain(
    "Scores don't match",
    "A re-score gave different points from the stored ones, so they weren't changed.",
    [GO_SCORING],
  ),
  scoring_retried: plain(
    "Scoring was retried",
    "A scoring run failed and was run again.",
    [GO_SCORING],
  ),
  ruleset_version_refused: plain(
    "A ruleset version was refused",
    "A ruleset version couldn't be used for the game.",
    [GO_SCORING],
  ),
  game_event_reinstated: plain(
    "An event is back in the game",
    (v) => `${eventName(v)} was cancelled and is back on the calendar.`,
    [GO_CALENDAR],
  ),
  prices_carried: plain(
    "Prices carried over",
    (v) =>
      `No price update ran before ${eventName(v)} opened, so last event's prices carried over.`,
    [GO_PRICES],
  ),

  // Calendar and roster.
  session_missing_from_provider: plain(
    "A session is missing from the provider",
    "The provider's calendar no longer lists a session we have.",
    [GO_CALENDAR],
  ),
  lock_session_changed: plain(
    "A lock's session moved",
    (v) => `The session ${eventName(v)} locks with has a new time.`,
    [GO_CALENDAR],
  ),
  lock_passed_changed: plain(
    "A session moved after its lock",
    (v) => `A session of ${eventName(v)} moved after the lock passed.`,
    [GO_CALENDAR],
  ),
  circuit_timezone_missing: plain(
    "A circuit has no time zone",
    "Local times can't be shown for this circuit until it has one.",
    [GO_CALENDAR],
  ),
  roster_unavailable: plain(
    "The roster couldn't be read",
    "The provider's roster didn't answer, so seats weren't checked.",
    [GO_SEATS],
  ),
  missing_constructor_color: plain(
    "A team has no colour",
    "A team this season has no colour yet. Screens use a plain one until it does.",
  ),

  // Jobs and accounts.
  job_dead: plain(
    "A job failed for good",
    "A background job failed every retry and stopped.",
  ),
  usage_high: plain(
    "A free tier is over 70%",
    "This month's usage of a free plan has passed 70% of its limit. Plan to upgrade before it runs out (HLD §11.4).",
  ),
  email_cap_near: plain(
    "Emails are near today's cap",
    "The day's email sending is close to its limit.",
  ),
  staff_verify_locked: plain(
    "A staff two-step sign-in was locked",
    "Too many wrong codes locked a staff account's two-step check.",
  ),
} satisfies Record<string, ReviewKindSpec>;

export type ReviewKind = keyof typeof REVIEW_KINDS;

/** The words and actions for a kind, or plain ones for one stored before. */
export function reviewKindSpec(kind: string): ReviewKindSpec {
  return (
    (REVIEW_KINDS as Record<string, ReviewKindSpec>)[kind] ??
    plain(labelOf(kind), "An item to look at.")
  );
}
