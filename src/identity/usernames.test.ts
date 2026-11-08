import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  cookieHeader,
  signUpRequest,
  testAuth,
} from "../../tests/helpers/auth";
import { seedUser } from "../../tests/helpers/users";
import {
  constructors,
  drivers,
  filterRules,
  profiles,
  usernameHistory,
  users,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import {
  changeUsername,
  checkUsername,
  normalizeForCheck,
  USERNAME_HOLD_DAYS,
} from "./usernames";
import { IdentityError } from "./viewer";

const NOW = new Date("2026-11-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("usernames", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const check = (name: string, userId?: string) =>
    checkUsername(t.db, NOW, name, userId ? { userId } : {});

  it("normalizeForCheck compares look-alikes alike", () => {
    expect(normalizeForCheck("F1_0fficial")).toBe(
      normalizeForCheck("f1official"),
    );
    expect(normalizeForCheck("Adm1n")).toBe("admln");
  });

  it.each([
    ["ab", "too short"],
    ["a".repeat(21), "too long"],
    ["two words", "a space"],
    ["caféx", "an accent"],
    ["аlex_f", "a Cyrillic a"],
    ["", "empty"],
  ])("format: %s (%s) is refused", async (name) => {
    expect(await check(name)).toBe("format");
  });

  it("format: a plain name passes", async () => {
    expect(await check("grid_fan.99")).toBeNull();
  });

  it.each(["F1_Official", "Formula1Fan", "FIA_steward", "admin", "gridlocked"])(
    "%s is reserved",
    async (name) => {
      expect(await check(name)).toBe("reserved");
    },
  );

  it("a name that merely contains f1 inside a word is not reserved", async () => {
    expect(await check("mf1_fan")).toBeNull();
  });

  it("MaxVerstappen and Ferrari are reserved", async () => {
    await t.db.insert(drivers).values({
      id: newId(),
      slug: "max_verstappen",
      givenName: "Max",
      familyName: "Verstappen",
      nationality: "Dutch",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await t.db.insert(constructors).values({
      id: newId(),
      slug: "ferrari",
      name: "Ferrari",
      nationality: "Italian",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await check("MaxVerstappen")).toBe("reserved");
    expect(await check("max_verstappen")).toBe("reserved");
    expect(await check("Verstappen")).toBe("reserved");
    expect(await check("Ferrari")).toBe("reserved");
    expect(await check("Ferrari_Fan")).toBeNull();
  });

  it("a look-alike with zeros is reserved", async () => {
    expect(await check("Gridl0cked")).toBe("reserved");
    expect(await check("0fficial_pick")).toBe("reserved");
    expect(await check("adm_in")).toBe("reserved");
  });

  it("1 read as i gets no one past the rules", async () => {
    for (const name of ["Adm1n", "Gr1dlocked", "Gr1dl0cked", "Gr1d1ocked"]) {
      expect(await check(name)).toBe("reserved");
    }
    await t.db.insert(constructors).values({
      id: newId(),
      slug: "red_bull",
      name: "Red Bull",
      nationality: "Austrian",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await t.db.insert(drivers).values({
      id: newId(),
      slug: "gasly",
      givenName: "Pierre",
      familyName: "Gasly",
      nationality: "French",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await check("P1erreGasly")).toBe("reserved");
    expect(await check("P1erreGas1y")).toBe("reserved");
    expect(await check("Lily_Fan")).toBeNull();
    expect(await check("Gasly_Fan")).toBeNull();
    expect(await check("Red_Bu11")).toBe("reserved");
  });

  it("a rule turned off stops applying", async () => {
    expect(await check("support")).toBe("reserved");
    await t.db
      .update(filterRules)
      .set({ active: false })
      .where(eq(filterRules.pattern, "support"));
    expect(await check("support")).toBeNull();
  });

  it("the name is taken whatever its case", async () => {
    await seedUser(t.db, { username: "Ada_Lovelace" });
    expect(await check("ada_lovelace")).toBe("taken");
    expect(await check("ADA_LOVELACE")).toBe("taken");
    // The holder is not told their own name is taken.
    const [row] = await t.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "ada_lovelace"));
    expect(await check("ADA_lovelace", row!.id)).toBeNull();
  });

  it("an old name is held for 90 days, then released", async () => {
    const old = await seedUser(t.db, { username: "now_new" });
    await t.db.insert(usernameHistory).values({
      id: newId(),
      userId: old,
      username: "OldName",
      changedAt: daysAgo(USERNAME_HOLD_DAYS - 1),
    });
    expect(USERNAME_HOLD_DAYS).toBe(90);
    expect(await check("oldname")).toBe("held");

    await t.db
      .update(usernameHistory)
      .set({ changedAt: daysAgo(USERNAME_HOLD_DAYS + 1) });
    expect(await check("oldname")).toBeNull();
  });

  it("a user can take their own old name back", async () => {
    const id = await seedUser(t.db, { username: "second_name" });
    await t.db.insert(usernameHistory).values({
      id: newId(),
      userId: id,
      username: "first_name",
      changedAt: daysAgo(40),
    });
    expect(await check("first_name")).toBe("held");
    expect(await check("first_name", id)).toBeNull();
    await changeUsername(t.db, NOW, { userId: id, username: "first_name" });
    const [row] = await t.db.select().from(users).where(eq(users.id, id));
    expect(row?.username).toBe("first_name");
  });

  describe("changeUsername", () => {
    it("renames, writes history and starts the 30-day wait", async () => {
      const id = await seedUser(t.db, { username: "before_x" });
      await changeUsername(t.db, NOW, { userId: id, username: "After_X" });
      const [row] = await t.db.select().from(users).where(eq(users.id, id));
      expect(row?.username).toBe("after_x");
      expect(row?.displayUsername).toBe("After_X");
      const history = await t.db.select().from(usernameHistory);
      expect(history).toHaveLength(1);
      expect(history[0]?.username).toBe("before_x");
      expect(history[0]?.changedAt).toEqual(NOW);
      const [profile] = await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, id));
      expect(profile?.usernameChangedAt).toEqual(NOW);
    });

    it("a second change inside 30 days is refused", async () => {
      const id = await seedUser(t.db, { username: "before_x" });
      await changeUsername(t.db, NOW, { userId: id, username: "after_x" });
      const later = new Date(NOW.getTime() + 29 * DAY);
      await expect(
        changeUsername(t.db, later, { userId: id, username: "third_x" }),
      ).rejects.toMatchObject({ code: "username_too_soon" });
      const after = new Date(NOW.getTime() + 31 * DAY);
      await changeUsername(t.db, after, { userId: id, username: "third_x" });
      const [row] = await t.db.select().from(users).where(eq(users.id, id));
      expect(row?.username).toBe("third_x");
    });

    it("changing only the capitals isn't a change", async () => {
      const id = await seedUser(t.db, { username: "lowercase_x" });
      await changeUsername(t.db, NOW, { userId: id, username: "after_x" });
      const later = new Date(NOW.getTime() + DAY);
      await changeUsername(t.db, later, { userId: id, username: "After_X" });
      const [row] = await t.db.select().from(users).where(eq(users.id, id));
      expect(row?.username).toBe("after_x");
      expect(row?.displayUsername).toBe("After_X");
      expect(await t.db.select().from(usernameHistory)).toHaveLength(1);
      const [profile] = await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, id));
      expect(profile?.usernameChangedAt).toEqual(NOW);
    });

    it("a first username writes no history and starts no wait", async () => {
      const id = await seedUser(t.db, { username: "tmp_first" });
      await t.db
        .update(users)
        .set({ username: null, displayUsername: null })
        .where(eq(users.id, id));
      await changeUsername(t.db, NOW, { userId: id, username: "First_One" });
      const [row] = await t.db.select().from(users).where(eq(users.id, id));
      expect(row?.username).toBe("first_one");
      expect(await t.db.select().from(usernameHistory)).toHaveLength(0);
      const [profile] = await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, id));
      expect(profile?.usernameChangedAt).toBeNull();
    });

    it("refuses a name the check refuses", async () => {
      const id = await seedUser(t.db, { username: "before_x" });
      await seedUser(t.db, { username: "taken_one" });
      await expect(
        changeUsername(t.db, NOW, { userId: id, username: "Taken_One" }),
      ).rejects.toMatchObject({ code: "taken" });
      await expect(
        changeUsername(t.db, NOW, { userId: id, username: "admin" }),
      ).rejects.toMatchObject({ code: "reserved" });
    });

    it("two people racing for one name: one wins, the other gets taken", async () => {
      const a = await seedUser(t.db, { username: "racer_a" });
      const b = await seedUser(t.db, { username: "racer_b" });
      const pass = async () => null;
      const results = await Promise.allSettled([
        changeUsername(
          t.db,
          NOW,
          { userId: a, username: "Prize" },
          { check: pass },
        ),
        changeUsername(
          t.db,
          NOW,
          { userId: b, username: "prize" },
          { check: pass },
        ),
      ]);
      const failed = results.filter((r) => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const reason = (failed[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(IdentityError);
      expect((reason as IdentityError).code).toBe("taken");
      // The loser keeps their name and has no history row.
      const names = (await t.db.select().from(users))
        .filter((u) => u.role !== "system")
        .map((u) => u.username)
        .sort();
      expect(names).toEqual(["prize", expect.stringMatching(/^racer_/)]);
      expect(await t.db.select().from(usernameHistory)).toHaveLength(1);
    });
  });

  describe("through Better Auth", () => {
    it("sign-up with a reserved name is refused", async () => {
      const auth = testAuth(t.db);
      const response = await auth.handler(
        signUpRequest("ada@example.test", { username: "F1_Official" }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        (await t.db.select().from(users)).filter((u) => u.role !== "system"),
      ).toHaveLength(0);
    });

    it("sign-up keeps the name as typed and stores it in lower case", async () => {
      const auth = testAuth(t.db);
      const response = await auth.handler(
        signUpRequest("ada@example.test", { username: "Ada_Fan" }),
      );
      expect(response.status).toBe(200);
      const [row] = await t.db
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.test"));
      expect(row?.username).toBe("ada_fan");
      expect(row?.displayUsername).toBe("Ada_Fan");
      // Taken whatever its case, through the plugin.
      const again = await auth.handler(
        signUpRequest("bob@example.test", { username: "ADA_FAN" }),
      );
      expect(again.status).toBeGreaterThanOrEqual(400);
    });

    it("a reserved display name on a plain username is refused at sign-up", async () => {
      const auth = testAuth(t.db);
      const response = await auth.handler(
        signUpRequest("ada@example.test", {
          username: "plain_guy",
          displayUsername: "F1_Official",
        }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        (await t.db.select().from(users)).filter((u) => u.role !== "system"),
      ).toHaveLength(0);
    });

    it("a display name that isn't the username is refused", async () => {
      const auth = testAuth(t.db);
      const response = await auth.handler(
        signUpRequest("ada@example.test", {
          username: "plain_guy",
          displayUsername: "Other_Guy",
        }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      const ok = await auth.handler(
        signUpRequest("bob@example.test", {
          username: "plain_guy",
          displayUsername: "Plain_Guy",
        }),
      );
      expect(ok.status).toBe(200);
    });

    it("a display name sent without a username is refused at sign-up", async () => {
      const auth = testAuth(t.db);
      const response = await auth.handler(
        signUpRequest("ada@example.test", { displayUsername: "Plain_Guy" }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        (await t.db.select().from(users)).filter((u) => u.role !== "system"),
      ).toHaveLength(0);
    });

    it("the username sign-in and availability paths answer 404", async () => {
      const auth = testAuth(t.db);
      for (const path of ["/sign-in/username", "/is-username-available"]) {
        const response = await auth.handler(
          authPost(path, { username: "plain_guy", password: "x" }),
        );
        expect(response.status).toBe(404);
      }
    });

    it("renaming through update-user is refused", async () => {
      const auth = testAuth(t.db);
      const signUp = await auth.handler(
        signUpRequest("ada@example.test", { username: "Ada_Fan" }),
      );
      const cookie = cookieHeader(signUp);
      for (const body of [
        { username: "someone_else" },
        { displayUsername: "SomeoneElse" },
      ]) {
        const response = await auth.handler(
          authPost("/update-user", body, { cookie }),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      const [row] = await t.db
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.test"));
      expect(row?.username).toBe("ada_fan");
      expect(row?.displayUsername).toBe("Ada_Fan");
    });
  });
});
