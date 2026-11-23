import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { currentDocuments } from "./consent";
import { publishLegal } from "./legal-publish";

describe("publishLegal (M9 Task 13)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("on a replay database it dates the notice at the replay clock, so it's in force there at once", async () => {
    const at = "2026-03-06T12:00:00.000Z";
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', $1::jsonb)",
      [JSON.stringify({ at })],
    );

    const first = await publishLegal(t.db, "replay", "beta");
    expect(first).toEqual({
      published: true,
      version: "beta-1",
      at: new Date(at),
    });
    expect(await publishLegal(t.db, "replay", "beta")).toMatchObject({
      published: false,
    });

    const kinds = (await currentDocuments(t.db, new Date(at))).map(
      (d) => d.kind,
    );
    expect(kinds).toContain("beta");
  });

  it("refuses a kind that has no published text", async () => {
    await expect(publishLegal(t.db, "system", "terms")).rejects.toThrow(
      /no text to publish for "terms"/,
    );
  });
});
