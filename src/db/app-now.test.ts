import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";

type Ts = { t: string };

describe("app_now()", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function setClock(json: string) {
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', $1::jsonb)",
      [json],
    );
  }

  it("returns now() when there is no simulated_clock row", async () => {
    const { rows } = await t.client.query<{ diff: number }>(
      "select abs(extract(epoch from (app_now() - now())))::float8 as diff",
    );
    expect(rows[0]!.diff).toBeLessThan(5);
  });

  it("returns the simulated time when the setting is {at}", async () => {
    await setClock('{"at":"2026-10-31T20:00:00Z"}');
    const { rows } = await t.client.query<Ts>(
      "select to_char(app_now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as t",
    );
    expect(rows[0]!.t).toBe("2026-10-31T20:00:00Z");
  });

  it("raises on an unparseable timestamp", async () => {
    await setClock('{"at":"not a date"}');
    await expect(t.client.query("select app_now()")).rejects.toThrow(
      "invalid simulated_clock setting",
    );
  });

  it("raises when the value has no string at", async () => {
    await setClock('{"foo":1}');
    await expect(t.client.query("select app_now()")).rejects.toThrow(
      "invalid simulated_clock setting",
    );
  });

  it("raises when at is not a string", async () => {
    await setClock('{"at":12345}');
    await expect(t.client.query("select app_now()")).rejects.toThrow(
      "invalid simulated_clock setting",
    );
  });

  it("raises when the value is not an object", async () => {
    await setClock('"2026-10-31T20:00:00Z"');
    await expect(t.client.query("select app_now()")).rejects.toThrow(
      "invalid simulated_clock setting",
    );
  });
});
