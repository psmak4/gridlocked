/**
 * Work after Better Auth's commit can't be lost (M9 Task 2, carried from M5).
 * Each test makes one of our writes fail the first time, with a trigger, and
 * checks that what Better Auth committed still gets its email, audit or
 * revoke: on the spot where it can, else from the job the runner retries.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  cookieHeader,
  linkIn,
  PASSWORD,
  recordingSender,
  signUpRequest,
  TEST_NOW,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import {
  auditLog,
  authAccounts,
  authSessions,
  emailOutbox,
  jobs,
  legalAcceptances,
  profiles,
  users,
} from "@/db/schema";
import { runDue } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { simulatedClock } from "@/lib/clock";
import { createIdentityAfterCommitHandler } from "./after-commit";

const EMAIL = "ada@example.test";
const NEW_PASSWORD = "a brand new password";

describe("work after Better Auth's commit", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;

  /** Every insert into `table` fails until `heal` drops the trigger. */
  const breakInserts = async (table: string) => {
    await t.db.execute(
      sql.raw(`create or replace function test_fail_insert() returns trigger
        language plpgsql as $$ begin raise exception 'test: insert refused'; end $$`),
    );
    await t.db.execute(
      sql.raw(`create trigger test_fail before insert on ${table}
        for each row execute function test_fail_insert()`),
    );
    return async () => {
      await t.db.execute(sql.raw(`drop trigger test_fail on ${table}`));
    };
  };

  /** The tick, a few minutes later: every due job runs. */
  const runJobs = (minutes = 5) =>
    runDue(
      t.db,
      simulatedClock(new Date(TEST_NOW.getTime() + minutes * 60_000)),
      { identity_after_commit: createIdentityAfterCommitHandler() },
      { maxJobs: 10, leaseMs: 60_000 },
    );

  const userId = async () => {
    const [user] = await t.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EMAIL));
    return user!.id;
  };

  const audits = (action: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.action, action));

  beforeEach(async () => {
    t = await createTestDb();
    mail = recordingSender();
    auth = testAuth(t.db, { sender: mail.sender });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it("an audit row or email queued after Better Auth's transaction is written even when the hook after it throws", async () => {
    // The profile insert after the commit fails, as a database blip would.
    const heal = await breakInserts("profiles");
    const signUp = await auth.handler(signUpRequest(EMAIL));
    expect(signUp.status).toBe(200);

    // The confirmation email committed with the account, and went.
    expect(mail.last(EMAIL, "Confirm your email")).toBeDefined();
    expect(
      await t.db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.template, "verify_email")),
    ).toHaveLength(1);

    // The two boxes the form carried wait in a job, not in memory.
    const id = await userId();
    expect(
      await t.db.select().from(profiles).where(eq(profiles.userId, id)),
    ).toHaveLength(0);
    await heal();
    await runJobs();
    const [profile] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, id));
    expect(profile?.ageConfirmedAt).not.toBeNull();
    expect(
      await t.db
        .select()
        .from(legalAcceptances)
        .where(eq(legalAcceptances.userId, id)),
    ).not.toHaveLength(0);
  });

  it("an audit after Better Auth's commit is written once, even when the first try fails", async () => {
    const signUp = await auth.handler(signUpRequest(EMAIL));
    const heal = await breakInserts("audit_log");
    const change = await auth.handler(
      authPost(
        "/change-password",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { cookie: cookieHeader(signUp) },
      ),
    );
    expect(change.status).toBe(200);
    expect(await audits("user.password.update")).toHaveLength(0);

    await heal();
    await runJobs();
    await runJobs(30);
    expect(await audits("user.password.update")).toHaveLength(1);
    // The sign-up's job and the audit's: finished, and keeping nothing of
    // what they did.
    const kept = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, "identity_after_commit"));
    expect(kept.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect(kept.map((j) => j.payload)).toEqual([{}, {}]);
  });

  it("onPasswordReset revokes the other sessions even when the reset's email fails", async () => {
    // An unconfirmed account that someone linked a Discord sign-in to.
    await auth.handler(signUpRequest(EMAIL));
    const id = await userId();
    await t.db.insert(authAccounts).values({
      id: newId(),
      userId: id,
      providerId: "discord",
      accountId: "3001",
      createdAt: new Date(TEST_NOW.getTime() - 3_600_000),
      updatedAt: new Date(TEST_NOW.getTime() - 3_600_000),
    });

    await auth.handler(
      authPost(
        "/request-password-reset",
        { email: EMAIL },
        { "x-forwarded-for": "203.0.113.30" },
      ),
    );
    const token = new URL(linkIn(mail.last(EMAIL, "Reset your"))).pathname
      .split("/")
      .pop()!;
    const heal = await breakInserts("audit_log");
    const reset = await auth.handler(
      authPost("/reset-password", { newPassword: NEW_PASSWORD, token }),
    );
    expect(reset.status).toBe(200);
    await heal();

    // The owner signs in with the new password before the retry runs; that
    // session is theirs, and the retry leaves it alone.
    const signIn = await auth.handler(
      authPost("/sign-in/email", { email: EMAIL, password: NEW_PASSWORD }),
    );
    expect(signIn.status).toBe(200);
    await runJobs();

    const links = await t.db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, id),
          eq(authAccounts.providerId, "discord"),
        ),
      );
    expect(links).toHaveLength(0);
    expect(await audits("user.accounts.revoke_unproven")).toHaveLength(1);
    expect(await audits("user.password.update")).toHaveLength(1);
    expect(
      await t.db.select().from(authSessions).where(eq(authSessions.userId, id)),
    ).toHaveLength(1);
  });
});
