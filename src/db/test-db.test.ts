import { describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";

describe("createTestDb", () => {
  it("gives each call an isolated, fully migrated database", async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    try {
      await a.client.query(
        "insert into settings (key, value) values ('only_in_a', '1'::jsonb)",
      );
      const inA = await a.client.query("select key from settings");
      const inB = await b.client.query("select key from settings");
      expect(inA.rows).toEqual([{ key: "only_in_a" }]);
      expect(inB.rows).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("allows creating btree_gist and ltree in each database", async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    try {
      for (const t of [a, b]) {
        await t.client.exec(
          "create extension btree_gist; create extension ltree;",
        );
        const { rows } = await t.client.query<{ extname: string }>(
          "select extname from pg_extension where extname in ('btree_gist','ltree') order by 1",
        );
        expect(rows.map((r) => r.extname)).toEqual(["btree_gist", "ltree"]);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
