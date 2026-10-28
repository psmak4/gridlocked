import { sql, type SQL } from "drizzle-orm";
import { timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

// Shared by the schema files. Not re-exported from `index.ts`: these are
// building blocks, not tables.

/**
 * `column in ('a', 'b', ...)` for a CHECK, from the same `as const` list the TS type uses.
 * The values are inlined as literals: a CHECK cannot hold bind parameters. They
 * are compile-time constants, never user input.
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = sql.raw(
    values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "),
  );
  return sql`${column} in (${list})`;
}

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
