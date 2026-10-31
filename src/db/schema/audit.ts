import {
  index,
  jsonb,
  pgTable,
  text,
  uuid,
  check,
  timestamp,
} from "drizzle-orm/pg-core";
import { oneOf } from "./helpers";

export const AUDIT_ACTOR_KINDS = [
  "admin",
  "moderator",
  "user",
  "system",
  "job",
] as const;

/**
 * DM 6.6: everything staff change, written in the same transaction as the
 * change (DM 0.4). Append-only: a trigger refuses UPDATE and DELETE, so a
 * mistaken action is fixed by a new action.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    /** UUIDv7, so ordered by time. */
    id: uuid("id").primaryKey(),
    // FK to users added in M5
    actorUserId: uuid("actor_user_id"),
    actorKind: text("actor_kind", { enum: AUDIT_ACTOR_KINDS }).notNull(),
    /** Who acted while there are no user rows (the staff workflow's GitHub login). */
    actorLabel: text("actor_label"),
    // FK to users added in M5
    impersonatingUserId: uuid("impersonating_user_id"),
    /** Dotted names, e.g. `event_entry.create`, `seat_assignment.close`. */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    /** Polymorphic, like `provider_ids` (DM 1.11). */
    entityId: uuid("entity_id").notNull(),
    /** Only the changed fields. */
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    /** Ties together all the entries from one request. */
    requestId: text("request_id"),
    /** Set by the caller's clock, never the database's (HLD decision 20). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("audit_log_actor_kind_check", oneOf(t.actorKind, AUDIT_ACTOR_KINDS)),
    index("audit_log_entity_type_entity_id_created_at_idx").on(
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    index("audit_log_actor_user_id_created_at_idx").on(
      t.actorUserId,
      t.createdAt,
    ),
  ],
);
