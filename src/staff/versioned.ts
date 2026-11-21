/**
 * Optimistic concurrency for staff queues (M8 Task 3, DM 0.7). A resolve names
 * the version it read; the update matches only that version while the item
 * is still open, and bumps it. No row back means someone else got there
 * first, and nothing is written.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "@/db/types";

/** A table with the three columns a versioned resolve needs. */
type Versioned = PgTable & {
  id: PgColumn;
  version: PgColumn;
  status: PgColumn;
};

/**
 * Sets `set` on the open row `id` at `version`, and the version one higher.
 * True if it updated. Run it inside the transaction that writes the rest
 * (the audit row, the action's own changes), and roll back on false.
 */
export async function resolveVersioned<T extends Versioned>(
  tx: Db,
  table: T,
  { id, version }: { id: string; version: number },
  set: PgUpdateSetSource<T>,
): Promise<boolean> {
  const rows = await tx
    .update(table)
    .set({ ...set, version: sql`${table.version} + 1` } as PgUpdateSetSource<T>)
    .where(
      and(
        eq(table.id, id),
        eq(table.version, version),
        eq(table.status, "open"),
      ),
    )
    .returning({ id: table.id });
  return rows.length === 1;
}
