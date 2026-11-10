import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import * as schema from "@/db/schema";
import { profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { scrubAccount } from "./delete";
import { updateProfile } from "./profile";
import { requestExport } from "./export";
import { clearTrustLock, recomputeTrustLevels, setTrustLevel } from "./trust";

// Ruling 59: every path that locks a user's profile and then points a new row
// at the user takes the `users` row first, as the deletion scrub does. PGlite
// has one connection, so two transactions can't contend here; the order of
// the statements each path sends is what is pinned.

const NOW = new Date("2026-11-08T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

type Step = "users" | "profiles" | "insert";

describe("lock order: users, then profiles", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let sent: string[];
  /** The same database, with every statement recorded. */
  let db: Db;

  beforeEach(async () => {
    t = await createTestDb();
    sent = [];
    db = drizzle(t.client, {
      schema,
      logger: { logQuery: (query) => sent.push(query) },
    }) as unknown as Db;
  });
  afterEach(async () => {
    await t.close();
  });

  /**
   * The locks and the first insert pointing at the user, in the order sent:
   * a row lock on `users` or `profiles` (an explicit FOR ... or an UPDATE of
   * the profile), then an insert into `table`.
   */
  function steps(table: string): Step[] {
    const out: Step[] = [];
    for (const query of sent) {
      const q = query.toLowerCase();
      if (/ for (no key )?update/.test(q) && /from "users"/.test(q)) {
        out.push("users");
      } else if (
        (/ for (no key )?update/.test(q) && /from "profiles"/.test(q)) ||
        q.startsWith('update "profiles"')
      ) {
        out.push("profiles");
      } else if (q.startsWith(`insert into "${table}"`)) {
        out.push("insert");
      }
    }
    // The first of each, in order.
    return out.filter((step, i) => out.indexOf(step) === i);
  }

  it("the scrub, for reference", async () => {
    const userId = await seedUser(t.db);
    await scrubAccount(db, NOW, {
      userId,
      actor: { kind: "user", userId, label: null },
    });
    expect(steps("audit_log").slice(0, 2)).toEqual(["users", "profiles"]);
  });

  it("updateProfile locks the profile row as it reads it", async () => {
    const userId = await seedUser(t.db);
    await updateProfile(db, NOW, {
      userId,
      expectedVersion: 1,
      timezone: "Europe/London",
    });
    const reads = sent
      .map((q) => q.toLowerCase())
      .filter((q) => /^select .* from "profiles"/.test(q));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/ for no key update$/);
  });

  it("requestExport", async () => {
    const userId = await seedUser(t.db);
    await requestExport(db, NOW, { userId });
    expect(steps("privacy_requests")).toEqual(["users", "profiles", "insert"]);
  });

  it("setTrustLevel and clearTrustLock", async () => {
    const userId = await seedUser(t.db);
    const mod = await seedUser(t.db, { role: "moderator" });
    const actor = { kind: "moderator" as const, label: "Mod", userId: mod };
    await setTrustLevel(db, NOW, {
      userId,
      level: 2,
      reason: "helper",
      actor,
    });
    expect(steps("trust_level_changes")).toEqual([
      "users",
      "profiles",
      "insert",
    ]);
    sent = [];
    await clearTrustLock(db, NOW, { userId, reason: "back to auto", actor });
    expect(steps("audit_log")).toEqual(["users", "profiles", "insert"]);
  });

  it("recomputeTrustLevels, one user at a time", async () => {
    const ids = [await seedUser(t.db), await seedUser(t.db)];
    for (const id of ids) {
      await t.db
        .update(profiles)
        .set({ daysVisited: 5, lastSeenAt: new Date(NOW.getTime() - DAY) })
        .where(eq(profiles.userId, id));
    }
    const transactions = vi.spyOn(db, "transaction");
    const r = await recomputeTrustLevels(db, NOW, {
      counts: async (_db, userIds) =>
        new Map(userIds.map((id) => [id, { posts: 10, upheldActions: 0 }])),
    });
    expect(r.changed).toBe(2);
    // Each change is its own transaction, so none holds one user's rows
    // while it waits for the next user's.
    expect(transactions).toHaveBeenCalledTimes(2);
    const writes = sent
      .map((q) => q.toLowerCase())
      .flatMap((q): Step[] =>
        / for no key update/.test(q) && /from "users"/.test(q)
          ? ["users"]
          : q.startsWith('update "profiles"')
            ? ["profiles"]
            : q.startsWith('insert into "trust_level_changes"')
              ? ["insert"]
              : [],
      );
    expect(writes).toEqual([
      "users",
      "profiles",
      "insert",
      "users",
      "profiles",
      "insert",
    ]);
  });
});
