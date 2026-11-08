import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  GAME_NOW,
  seedOpenGame,
  seedPlayer,
} from "../../tests/helpers/account-2026";
import { createMemoryExportStore } from "../../tests/helpers/memory-export-store";
import { errorCode } from "../../tests/helpers/staff";
import { seedUser } from "../../tests/helpers/users";
import {
  PASSWORD,
  recordingSender,
  signUpRequest,
  testAuth,
} from "../../tests/helpers/auth";
import {
  authAccounts,
  authSessions,
  authTwoFactors,
  authVerifications,
  emailOutbox,
  privacyRequests,
  users,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { runDue } from "@/jobs/runner";
import { completeSignUp } from "./consent";
import { DAILY_STEPS, createIdentityDailyHandler } from "./daily";
import { scrubAccount } from "./delete";
import {
  buildExport,
  createPrivacyExportHandler,
  EXPORT_LINK_SECONDS,
  expireExports,
  requestExport,
} from "./export";

const NOW = new Date("2026-11-08T06:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LEASE = 5 * MIN;

/** Every string in `value`, keys included, at any depth. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

const SECRET_WORDS = /token|hash|secret|password|totp|backup|otp/i;

describe("data export (DM 6.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let files: ReturnType<typeof createMemoryExportStore>;
  let mail: ReturnType<typeof recordingSender>;
  const clock = simulatedClock(NOW);

  beforeEach(async () => {
    t = await createTestDb();
    files = createMemoryExportStore();
    mail = recordingSender();
    clock.set(NOW);
  });
  afterEach(async () => {
    await t.close();
  });

  const runJobs = (at: Date) => {
    clock.set(at);
    return runDue(
      t.db,
      clock,
      {
        privacy_export: createPrivacyExportHandler({
          store: files.store,
          sender: mail.sender,
        }),
      },
      { maxJobs: 10, leaseMs: LEASE },
    );
  };
  const request = async (id: string) =>
    (
      await t.db
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.id, id))
    )[0]!;

  it("the export has the DM's sections", async () => {
    const game = await seedOpenGame(t.db);
    const player = await seedPlayer(t.db, game, { username: "Ada_Fan" });
    await completeSignUp(t.db, GAME_NOW, {
      userId: player.userId,
      ageConfirmed: true,
      accepted: true,
    });

    const data = (await buildExport(t.db, player.userId)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(data).sort()).toEqual(
      [
        "account",
        "leaguesOwned",
        "legalAcceptances",
        "privacyRequests",
        "profile",
        "sessions",
        "signInMethods",
        "teams",
        "trustLevelChanges",
        "usernameHistory",
      ].sort(),
    );
    expect(data.account).toMatchObject({
      id: player.userId,
      username: "ada_fan",
      displayUsername: "Ada_Fan",
    });
    expect(data.profile).toMatchObject({ status: "active" });
    const [team] = data.teams as Array<Record<string, unknown>>;
    expect(team).toMatchObject({ id: player.teamId, name: "Box Box" });
    const lineups = team!.lineups as Array<{ picks: unknown[] }>;
    expect(lineups).toHaveLength(1);
    expect(lineups[0]!.picks).toHaveLength(7);
    expect(team!.chipPlays).toEqual([]);
    expect(team!.leagueMemberships).toMatchObject([
      { league: "Pit Wall", kind: "private", leftAt: null },
    ]);
    expect(data.leaguesOwned).toMatchObject([{ name: "Pit Wall" }]);
    expect((data.legalAcceptances as unknown[]).length).toBeGreaterThan(0);
  });

  it("has no tokens, hashes or secrets", async () => {
    const auth = testAuth(t.db);
    const email = "ada@example.test";
    expect((await auth.handler(signUpRequest(email))).status).toBe(200);
    const [user] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    const userId = user!.id;

    const seeded = {
      accessToken: "seeded-discord-access-9f3a",
      refreshToken: "seeded-discord-refresh-77c1",
      idToken: "seeded-discord-id-0b2e",
      totpSecret: "SEEDEDTOTPSECRET4411",
      backupCodes: "seeded-backup-aaaa,seeded-backup-bbbb",
      sessionToken: "seeded-session-token-5d6e",
      confirmHash: "seeded-confirm-hash-c0ffee",
      exportUrl: "https://files.example.test/signed?X-Amz-Signature=abc123",
    };
    await t.db.insert(authAccounts).values({
      id: newId(),
      accountId: "4242",
      providerId: "discord",
      userId,
      accessToken: seeded.accessToken,
      refreshToken: seeded.refreshToken,
      idToken: seeded.idToken,
      scope: "identify email",
    });
    await t.db.insert(authTwoFactors).values({
      id: newId(),
      userId,
      secret: seeded.totpSecret,
      backupCodes: seeded.backupCodes,
    });
    await t.db.insert(authSessions).values({
      id: newId(),
      userId,
      token: seeded.sessionToken,
      expiresAt: new Date(NOW.getTime() + DAY),
      ipAddress: "203.0.113.9",
      userAgent: "Test Browser",
    });
    await t.db.insert(authVerifications).values({
      id: `v-${newId()}`,
      identifier: `magic-link:seededhash`,
      value: JSON.stringify({ email }),
      expiresAt: new Date(NOW.getTime() + DAY),
    });
    await t.db.insert(privacyRequests).values({
      id: newId(),
      userId,
      kind: "delete",
      status: "pending",
      requestedAt: NOW,
      confirmTokenHash: seeded.confirmHash,
      confirmExpiresAt: new Date(NOW.getTime() + DAY),
    });
    await t.db.insert(privacyRequests).values({
      id: newId(),
      userId,
      kind: "export",
      status: "completed",
      requestedAt: NOW,
      completedAt: NOW,
      exportObjectKey: "exports/x.json",
      exportExpiresAt: new Date(NOW.getTime() + DAY),
      exportUrl: seeded.exportUrl,
    });
    const secrets = [
      ...Object.values(seeded),
      ...(await t.db.select().from(authAccounts))
        .flatMap((a) => [a.password, a.accessToken, a.refreshToken, a.idToken])
        .filter((v): v is string => v !== null),
      ...(await t.db.select().from(authSessions)).map((s) => s.token),
    ];
    expect(secrets.some((s) => s.includes(":"))).toBe(true); // the password hash

    const data = await buildExport(t.db, userId);
    const all = strings(data);
    expect(all.filter((s) => SECRET_WORDS.test(s))).toEqual([]);
    for (const secret of secrets) {
      expect(all.filter((s) => s.includes(secret))).toEqual([]);
    }
    expect(JSON.stringify(data)).not.toContain(PASSWORD);
    // The sign-in methods are there, by provider name only.
    expect(
      (data as { signInMethods: Array<{ provider: string }> }).signInMethods
        .map((m) => m.provider)
        .sort(),
    ).toEqual(["credential", "discord"]);
  });

  it("one open request at a time, and one a day", async () => {
    const userId = await seedUser(t.db);
    const { requestId } = await requestExport(t.db, NOW, { userId });
    expect(
      await errorCode(() =>
        requestExport(t.db, new Date(NOW.getTime() + MIN), { userId }),
      ),
    ).toBe("export_pending");

    await runJobs(new Date(NOW.getTime() + 2 * MIN));
    expect((await request(requestId)).status).toBe("completed");
    expect(
      await errorCode(() =>
        requestExport(t.db, new Date(NOW.getTime() + 3 * MIN), { userId }),
      ),
    ).toBe("export_too_soon");

    const tomorrow = new Date(NOW.getTime() + DAY);
    const again = await requestExport(t.db, tomorrow, { userId });
    expect(again.requestId).not.toBe(requestId);
    // Someone else is not held up by it.
    const other = await seedUser(t.db);
    await expect(
      requestExport(t.db, NOW, { userId: other }),
    ).resolves.toBeTruthy();
  });

  it("the link is signed for 7 days", async () => {
    const userId = await seedUser(t.db, { email: "ada@example.test" });
    const { requestId } = await requestExport(t.db, NOW, { userId });
    const ran = new Date(NOW.getTime() + MIN);
    expect((await runJobs(ran)).ran).toBe(1);

    const key = `exports/${requestId}.json`;
    expect(EXPORT_LINK_SECONDS).toBe(7 * 24 * 3600);
    expect(files.presigned).toEqual([{ key, seconds: EXPORT_LINK_SECONDS }]);
    expect(files.objects.has(key)).toBe(true);
    expect(JSON.parse(files.objects.get(key)!)).toMatchObject({
      generatedAt: ran.toISOString(),
      account: { id: userId },
    });
    const row = await request(requestId);
    expect(row).toMatchObject({
      status: "completed",
      completedAt: ran,
      exportObjectKey: key,
      exportExpiresAt: new Date(ran.getTime() + 7 * DAY),
    });
    expect(row.exportUrl).toContain(key);
    // The user is told, and the email expires within Resend's window.
    expect(mail.last("ada@example.test", "export")).toBeTruthy();
    const [sent] = await t.db.select().from(emailOutbox);
    expect(sent).toMatchObject({ template: "export_ready", status: "sent" });
    expect(sent!.expiresAt!.getTime()).toBeLessThanOrEqual(ran.getTime() + DAY);
    // Running the job again changes nothing.
    await runJobs(new Date(ran.getTime() + MIN));
    expect(files.puts).toHaveLength(1);
  });

  it("the file is gone after 7 days", async () => {
    const userId = await seedUser(t.db);
    const { requestId } = await requestExport(t.db, NOW, { userId });
    await runJobs(NOW);
    const key = `exports/${requestId}.json`;

    const almost = new Date(NOW.getTime() + 7 * DAY - MIN);
    expect(await expireExports(t.db, almost, files.store)).toBe(0);
    expect(files.objects.has(key)).toBe(true);

    const week = new Date(NOW.getTime() + 7 * DAY);
    expect(await expireExports(t.db, week, files.store)).toBe(1);
    expect(files.objects.has(key)).toBe(false);
    expect(await request(requestId)).toMatchObject({
      exportObjectKey: null,
      exportUrl: null,
    });
    expect(await expireExports(t.db, week, files.store)).toBe(0);
  });

  it("an export job for a deleted user stops, and any file goes at the next daily run", async () => {
    const actorOf = (userId: string) => ({
      kind: "user" as const,
      userId,
      label: "self",
    });
    // A job that runs after the deletion writes nothing and stores nothing.
    const gone = await seedUser(t.db);
    const first = await requestExport(t.db, NOW, { userId: gone });
    await scrubAccount(t.db, NOW, { userId: gone, actor: actorOf(gone) });
    const before = await request(first.requestId);
    await runJobs(new Date(NOW.getTime() + MIN));
    expect(files.puts).toEqual([]);
    expect(files.presigned).toEqual([]);
    expect(await request(first.requestId)).toEqual(before);
    expect(await t.db.select().from(emailOutbox)).toEqual([]);

    // A file made before the deletion goes at the next daily run, not in 7 days.
    const later = await seedUser(t.db);
    const second = await requestExport(t.db, NOW, { userId: later });
    await runJobs(NOW);
    const key = `exports/${second.requestId}.json`;
    expect(files.objects.has(key)).toBe(true);
    await scrubAccount(t.db, NOW, { userId: later, actor: actorOf(later) });
    expect((await request(second.requestId)).exportUrl).toBeNull();

    expect(DAILY_STEPS.at(-1)).toBe("expireExports");
    const lines: string[] = [];
    const daily = createIdentityDailyHandler({
      exportStore: files.store,
      log: (line) => lines.push(line),
    });
    const tomorrow = new Date(NOW.getTime() + DAY);
    clock.set(tomorrow);
    await daily({} as never, { db: t.db, clock });
    expect(files.objects.has(key)).toBe(false);
    expect(lines).toContain("identity_daily: expireExports expired=1");
    expect(await request(second.requestId)).toMatchObject({
      exportObjectKey: null,
    });
  });

  it("the export is refused for a deleted account", async () => {
    const userId = await seedUser(t.db);
    await scrubAccount(t.db, NOW, {
      userId,
      actor: { kind: "user", userId, label: "self" },
    });
    expect(await errorCode(() => requestExport(t.db, NOW, { userId }))).toBe(
      "inactive",
    );
  });
});
