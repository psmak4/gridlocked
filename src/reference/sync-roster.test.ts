import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  loadConstructors2026,
  loadDrivers2026,
} from "../../tests/helpers/roster-2026";
import { loadSeats2026, seedSeats2026 } from "../../tests/helpers/seats-2026";
import {
  constructorSeasons,
  constructors,
  drivers,
  providerIds,
  reviewItems,
  seasons,
  seatAssignments,
} from "@/db/schema";
import { teamColors2026 } from "@/design/tokens";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import type { RosterConstructor, RosterDriver } from "./roster-types";
import { syncConstructors, syncDrivers } from "./sync-roster";

describe("roster sync", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const clock = simulatedClock(new Date("2026-02-01T00:00:00.000Z"));

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const syncD = (items: RosterDriver[]) =>
    syncDrivers(t.db, clock, 2026, { items, snapshotId: newId() });
  const syncC = (items: RosterConstructor[]) =>
    syncConstructors(t.db, clock, 2026, { items, snapshotId: newId() });
  const keyRows = (entityType: "driver" | "constructor") =>
    t.db
      .select()
      .from(providerIds)
      .where(eq(providerIds.entityType, entityType));

  describe("syncDrivers", () => {
    it("creates every driver in the recorded list, with provider ids", async () => {
      const list = loadDrivers2026();
      const report = await syncD(list);

      expect(report).toEqual({
        created: list.length,
        updated: 0,
        unchanged: 0,
        reviewItems: 0,
        changed: list.length,
      });
      expect(await t.db.select().from(drivers)).toHaveLength(list.length);
      const keys = await keyRows("driver");
      expect(new Set(keys.map((k) => k.providerKey))).toEqual(
        new Set(list.map((d) => d.key)),
      );
      expect(new Set(keys.map((k) => k.provider))).toEqual(
        new Set(["jolpica"]),
      );
    });

    it("stores the provider's fields and builds the slug from its id", async () => {
      await syncD(loadDrivers2026());

      const [verstappen] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "max-verstappen"));
      expect(verstappen).toMatchObject({
        givenName: "Max",
        familyName: "Verstappen",
        code: "VER",
        permanentNumber: 3,
        displayName: null,
      });
      expect(verstappen!.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(verstappen!.nationality).not.toBe("");
      const [reserve] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "paul-aron"));
      expect(reserve).toMatchObject({
        code: null,
        permanentNumber: null,
        dateOfBirth: null,
        nationality: "",
      });
      expect(verstappen!.createdAt).toEqual(clock.now());
    });

    it("changes nothing on a rerun", async () => {
      const list = loadDrivers2026();
      await syncD(list);
      const before = await t.db.select().from(drivers);
      clock.advance(60_000);

      const report = await syncD(list);

      expect(report).toEqual({
        created: 0,
        updated: 0,
        unchanged: list.length,
        reviewItems: 0,
        changed: 0,
      });
      expect(await t.db.select().from(drivers)).toEqual(before);
    });

    it("updates a driver in place when the provider changes a field", async () => {
      const list = loadDrivers2026();
      await syncD(list);
      const [before] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "albon"));

      const changed = list.map((d) =>
        d.key === "albon" ? { ...d, code: "ALX", permanentNumber: 99 } : d,
      );
      const report = await syncD(changed);

      expect(report).toMatchObject({
        created: 0,
        updated: 1,
        unchanged: list.length - 1,
        changed: 1,
      });
      const [after] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "albon"));
      expect(after).toMatchObject({
        id: before!.id,
        code: "ALX",
        permanentNumber: 99,
        slug: "albon",
      });
      expect(await t.db.select().from(drivers)).toHaveLength(list.length);
    });

    it("keeps a stored value the provider now omits, and still takes ones it sends", async () => {
      const list = loadDrivers2026();
      await syncD(list);
      // An admin filled in what Jolpica lacks for a reserve driver.
      await t.db
        .update(drivers)
        .set({
          nationality: "Italian",
          code: "ARO",
          permanentNumber: 77,
          dateOfBirth: "2004-01-01",
        })
        .where(eq(drivers.slug, "paul-aron"));
      // Jolpica sends none of them, and a new code for another driver.
      const report = await syncD(
        list.map((d) => (d.key === "albon" ? { ...d, code: "ALX" } : d)),
      );

      expect(report).toMatchObject({ updated: 1, changed: 1 });
      const [aron] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "paul-aron"));
      expect(aron).toMatchObject({
        nationality: "Italian",
        code: "ARO",
        permanentNumber: 77,
        dateOfBirth: "2004-01-01",
      });
      const [albon] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "albon"));
      expect(albon!.code).toBe("ALX");
    });

    it("leaves display_name alone and never deletes a driver the list drops", async () => {
      const list = loadDrivers2026();
      await syncD(list);
      await t.db
        .update(drivers)
        .set({ displayName: "Kimi Antonelli" })
        .where(eq(drivers.slug, "antonelli"));

      const report = await syncD(list.filter((d) => d.key !== "bottas"));

      expect(report.changed).toBe(0);
      expect(await t.db.select().from(drivers)).toHaveLength(list.length);
      const [row] = await t.db
        .select()
        .from(drivers)
        .where(eq(drivers.slug, "antonelli"));
      expect(row!.displayName).toBe("Kimi Antonelli");
    });

    it("suffixes the slug of a driver whose name clashes", async () => {
      const [a] = loadDrivers2026();
      // Three provider ids that all kebab to the same slug.
      await syncD([
        { ...a!, key: "albon" },
        { ...a!, key: "albon_" },
        { ...a!, key: "albon-" },
      ]);

      const slugs = (await t.db.select().from(drivers))
        .map((d) => d.slug)
        .sort();
      expect(slugs).toEqual(["albon", "albon-2", "albon-3"]);
    });

    it("rolls back everything when a write fails", async () => {
      const [a, b] = loadDrivers2026();
      // A permanent number too large for the integer column.
      await expect(
        syncD([a!, { ...b!, permanentNumber: 2 ** 40 }]),
      ).rejects.toThrow();

      expect(await t.db.select().from(drivers)).toEqual([]);
      expect(await keyRows("driver")).toEqual([]);
    });
  });

  describe("syncConstructors", () => {
    it("creates the constructors, provider ids, the season and its constructor rows", async () => {
      const list = loadConstructors2026();
      const report = await syncC(list);

      expect(report).toEqual({
        created: list.length,
        updated: 0,
        unchanged: 0,
        reviewItems: 0,
        changed: list.length,
      });
      expect(await t.db.select().from(constructors)).toHaveLength(list.length);
      expect(await keyRows("constructor")).toHaveLength(list.length);
      const [season] = await t.db.select().from(seasons);
      expect(season).toMatchObject({ year: 2026, status: "upcoming" });
      const rows = await t.db.select().from(constructorSeasons);
      expect(rows).toHaveLength(list.length);
    });

    it("names the season entry after Jolpica's name and colors it from teamColors2026", async () => {
      await syncC(loadConstructors2026());

      const [rb] = await t.db
        .select()
        .from(constructors)
        .where(eq(constructors.slug, "red-bull"));
      expect(rb).toMatchObject({ name: "Red Bull", nationality: "Austrian" });
      const [entry] = await t.db
        .select()
        .from(constructorSeasons)
        .where(eq(constructorSeasons.constructorId, rb!.id));
      expect(entry).toMatchObject({
        displayName: "Red Bull",
        shortName: "Red Bull",
        color: teamColors2026.RBR,
      });
    });

    it("changes nothing on a rerun", async () => {
      const list = loadConstructors2026();
      await syncC(list);
      const before = await t.db.select().from(constructors);
      const beforeSeasons = await t.db.select().from(constructorSeasons);
      clock.advance(60_000);

      const report = await syncC(list);

      expect(report).toEqual({
        created: 0,
        updated: 0,
        unchanged: list.length,
        reviewItems: 0,
        changed: 0,
      });
      expect(await t.db.select().from(constructors)).toEqual(before);
      expect(await t.db.select().from(constructorSeasons)).toEqual(
        beforeSeasons,
      );
    });

    it("updates a constructor in place and leaves an admin's season entry alone", async () => {
      const list = loadConstructors2026();
      await syncC(list);
      const [before] = await t.db
        .select()
        .from(constructors)
        .where(eq(constructors.slug, "audi"));
      await t.db
        .update(constructorSeasons)
        .set({ shortName: "AUD", color: "#123456" })
        .where(eq(constructorSeasons.constructorId, before!.id));

      const report = await syncC(
        list.map((c) => (c.key === "audi" ? { ...c, name: "Audi F1" } : c)),
      );

      expect(report).toMatchObject({ created: 0, updated: 1, changed: 1 });
      const [after] = await t.db
        .select()
        .from(constructors)
        .where(eq(constructors.slug, "audi"));
      expect(after).toMatchObject({ id: before!.id, name: "Audi F1" });
      const [entry] = await t.db
        .select()
        .from(constructorSeasons)
        .where(eq(constructorSeasons.constructorId, before!.id));
      expect(entry).toMatchObject({ shortName: "AUD", color: "#123456" });
    });

    it("keeps a stored nationality the provider omits", async () => {
      const list = loadConstructors2026();
      await syncC(list);
      await t.db
        .update(constructors)
        .set({ nationality: "Swiss" })
        .where(eq(constructors.slug, "audi"));

      const report = await syncC(
        list.map((c) => (c.key === "audi" ? { ...c, nationality: "" } : c)),
      );

      expect(report.changed).toBe(0);
      const [row] = await t.db
        .select()
        .from(constructors)
        .where(eq(constructors.slug, "audi"));
      expect(row!.nationality).toBe("Swiss");
    });

    it("adds a season entry for a constructor already known from another season", async () => {
      const list = loadConstructors2026();
      await syncC(list);

      const report = await syncConstructors(t.db, clock, 2027, {
        items: list.slice(0, 2).map((c) => ({ ...c, teamCode: null })),
        snapshotId: newId(),
      });

      expect(report).toMatchObject({ created: 0, updated: 2, unchanged: 0 });
      const rows = await t.db.select().from(constructorSeasons);
      expect(rows).toHaveLength(list.length + 2);
    });

    it("uses a placeholder color and opens a warning when there is no team color", async () => {
      const list = loadConstructors2026();
      const report = await syncC([
        { ...list[0]!, teamCode: null },
        ...list.slice(1),
      ]);

      expect(report.reviewItems).toBe(1);
      const [entry] = await t.db
        .select()
        .from(constructorSeasons)
        .innerJoin(
          constructors,
          eq(constructors.id, constructorSeasons.constructorId),
        )
        .where(eq(constructors.slug, "alpine"));
      expect(entry!.constructor_seasons.color).toMatch(/^#[0-9a-f]{6}$/i);
      const items = await t.db.select().from(reviewItems);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "missing_constructor_color",
        severity: "warning",
        status: "open",
      });

      // Not duplicated on a rerun.
      const again = await syncC([
        { ...list[0]!, teamCode: null },
        ...list.slice(1),
      ]);
      expect(again).toMatchObject({ reviewItems: 0, changed: 0 });
      expect(await t.db.select().from(reviewItems)).toHaveLength(1);
    });

    it("fills in a placeholder color once the team code is known", async () => {
      const list = loadConstructors2026();
      await syncC([{ ...list[0]!, teamCode: null }, ...list.slice(1)]);

      const report = await syncC(list);

      expect(report).toMatchObject({ updated: 1, changed: 1 });
      const [entry] = await t.db
        .select()
        .from(constructorSeasons)
        .innerJoin(
          constructors,
          eq(constructors.id, constructorSeasons.constructorId),
        )
        .where(eq(constructors.slug, "alpine"));
      expect(entry!.constructor_seasons.color).toBe(teamColors2026.ALP);
    });
  });

  describe("seedSeats2026 after a sync", () => {
    it("links the seats to the synced drivers and constructors", async () => {
      await syncD(loadDrivers2026());
      await syncC(loadConstructors2026());
      const driversBefore = await t.db.select().from(drivers);
      const constructorsBefore = await t.db.select().from(constructors);

      const seeded = await seedSeats2026(t.db, clock.now());

      expect(await t.db.select().from(drivers)).toHaveLength(
        driversBefore.length,
      );
      expect(await t.db.select().from(constructors)).toHaveLength(
        constructorsBefore.length,
      );
      expect(await t.db.select().from(seasons)).toHaveLength(1);
      const [verstappen] = driversBefore.filter(
        (d) => d.slug === "max-verstappen",
      );
      expect(seeded.driverIds.get("max_verstappen")).toBe(verstappen!.id);
      const seats = await t.db.select().from(seatAssignments);
      expect(seats).toHaveLength(loadSeats2026().length);
      expect(
        await t.db
          .select()
          .from(seatAssignments)
          .where(
            and(
              eq(seatAssignments.driverId, verstappen!.id),
              eq(seatAssignments.carNumber, 3),
            ),
          ),
      ).toHaveLength(1);
    });

    it("still creates placeholders, with provider ids, when nothing was synced", async () => {
      await seedSeats2026(t.db, clock.now());
      const driverKeys = await keyRows("driver");
      expect(driverKeys.length).toBeGreaterThan(20);

      // A sync afterwards adopts them rather than duplicating.
      const list = loadDrivers2026();
      const seeded = await t.db.select().from(drivers);
      await syncD(list);
      const all = await t.db.select().from(drivers);
      expect(all).toHaveLength(list.length);
      expect(all.filter((d) => d.slug === "max-verstappen")).toHaveLength(1);
      expect(seeded.length).toBeLessThan(all.length);
    });
  });
});
