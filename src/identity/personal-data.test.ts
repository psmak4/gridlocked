import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { PERSONAL_DATA } from "./personal-data";

// The registry of every place a user's data lives (DM 6.7). Export and
// deletion both walk it, so a table missing from it would be missed by both.

const tables = (Object.values(schema) as unknown[]).filter(
  (value): value is PgTable => is(value, PgTable),
);

/** Every `table.column` with a foreign key to `users`, from the schema. */
function foreignKeysToUsers(): string[] {
  const found: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (getTableConfig(ref.foreignTable).name !== "users") continue;
      for (const column of ref.columns) {
        found.push(`${config.name}.${column.name}`);
      }
    }
  }
  return found.sort();
}

describe("the personal-data registry (DM 6.7)", () => {
  it("every table with a foreign key to users is in the registry", () => {
    const registered = new Set(
      PERSONAL_DATA.map((entry) => `${entry.table}.${entry.userColumn}`),
    );
    const keys = foreignKeysToUsers();
    // The walk itself must find something, or the test proves nothing.
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys.filter((key) => !registered.has(key))).toEqual([]);
  });

  it("every entry names a real table and column", () => {
    const columns = new Map(
      tables.map((table) => {
        const config = getTableConfig(table);
        return [config.name, new Set(config.columns.map((c) => c.name))];
      }),
    );
    for (const entry of PERSONAL_DATA) {
      expect(columns.has(entry.table), entry.table).toBe(true);
      expect(
        columns.get(entry.table)?.has(entry.userColumn),
        `${entry.table}.${entry.userColumn}`,
      ).toBe(true);
    }
    const pairs = PERSONAL_DATA.map((e) => `${e.table}.${e.userColumn}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('every "keep" says why', () => {
    for (const entry of PERSONAL_DATA) {
      if (entry.onDelete !== "keep") continue;
      expect(entry.why.trim().length, entry.table).toBeGreaterThan(20);
    }
    // And every other kind is something the scrub does.
    for (const entry of PERSONAL_DATA) {
      if (entry.onDelete === "keep") continue;
      expect(entry.scrub, `${entry.table}.${entry.userColumn}`).toBeTypeOf(
        "function",
      );
      expect(entry.why.trim().length).toBeGreaterThan(0);
    }
  });

  it("every exported section has a reader", () => {
    for (const entry of PERSONAL_DATA) {
      if (entry.exportAs === null) continue;
      expect(entry.read, entry.exportAs).toBeTypeOf("function");
    }
    const sections = PERSONAL_DATA.flatMap((e) =>
      e.exportAs === null ? [] : [e.exportAs],
    );
    expect(new Set(sections).size).toBe(sections.length);
  });
});
