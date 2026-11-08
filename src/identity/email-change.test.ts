import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  clickLink,
  cookieHeader,
  linkIn,
  PASSWORD,
  recordingSender,
  signUpRequest,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { auditLog, users } from "@/db/schema";

const OLD = "ada@example.test";
const NEW = "ada.new@example.test";

describe("changing the email address", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;
  let cookie: string;
  const ada = async () =>
    (await t.db.select().from(users).where(eq(users.id, adaId)))[0]!;
  let adaId: string;
  const change = () =>
    auth.handler(authPost("/change-email", { newEmail: NEW }, { cookie }));

  beforeEach(async () => {
    t = await createTestDb();
    mail = recordingSender();
    auth = testAuth(t.db, { sender: mail.sender });
    const signUp = await auth.handler(signUpRequest(OLD));
    cookie = cookieHeader(signUp);
    adaId = (await t.db.select().from(users).where(eq(users.email, OLD)))[0]!
      .id;
  });
  afterEach(async () => {
    await t.close();
  });

  it("an unverified address changes straight away and a new link goes out", async () => {
    const response = await change();
    expect(response.status).toBe(200);
    expect((await ada()).email).toBe(NEW);
    expect((await ada()).emailVerified).toBe(false);
    expect(mail.last(NEW, "Confirm your email")).toBeDefined();
    // The old address gets no notice: it was never confirmed.
    expect(mail.last(OLD, "changed")).toBeUndefined();
  });

  it("a verified address changes only after the new address confirms", async () => {
    await t.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, adaId));

    const response = await change();
    expect(response.status).toBe(200);
    expect((await ada()).email).toBe(OLD);

    const link = linkIn(mail.last(NEW, "Confirm your email"));
    const confirmed = await auth.handler(clickLink(link, cookie));
    expect(confirmed.status).toBeLessThan(400);
    expect((await ada()).email).toBe(NEW);
    expect((await ada()).emailVerified).toBe(true);
  });

  it("the old address gets a notice", async () => {
    await t.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, adaId));
    await change();
    const notice = mail.last(OLD, "The email on your Gridlocked account");
    expect(notice).toBeDefined();
    expect(notice?.text).not.toContain(NEW);
    expect(linkIn(notice)).toMatch(/^http/);
  });

  it("the change is audited with the addresses redacted", async () => {
    await change();
    const rows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === "user.email.update",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "user",
      actorUserId: adaId,
      entityType: "user",
      entityId: adaId,
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(OLD);
    expect(text).not.toContain(NEW);
    expect(text).toContain("[redacted]");
  });

  it("a verified address change is audited when the new address confirms", async () => {
    await t.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, adaId));
    await change();
    const rows = () =>
      t.db
        .select()
        .from(auditLog)
        .then((all) => all.filter((r) => r.action === "user.email.update"));
    expect((await rows())[0]?.after).toMatchObject({
      stage: "requested",
      applied: false,
    });

    await auth.handler(
      clickLink(linkIn(mail.last(NEW, "Confirm your email")), cookie),
    );
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      actorKind: "user",
      actorUserId: adaId,
      entityId: adaId,
      after: { stage: "applied", applied: true },
    });
    const text = JSON.stringify(all);
    expect(text).not.toContain(OLD);
    expect(text).not.toContain(NEW);
  });

  it("a forged change-email token writes no audit row", async () => {
    // An unsigned payload that names a real user's address, with a
    // callbackURL so the failure is a redirect, not an error status.
    const b64 = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const forged = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      email: OLD,
      updateTo: "someone.else@example.test",
      requestType: "change-email-verification",
      userId: adaId,
    })}.${b64("not a signature")}`;
    const response = await auth.handler(
      clickLink(
        `http://localhost:3000/api/auth/verify-email?token=${forged}&callbackURL=%2F`,
      ),
    );
    expect(response.status).toBe(302);
    expect((await ada()).email).toBe(OLD);
    const rows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === "user.email.update",
    );
    expect(rows).toHaveLength(0);
  });

  it("a replayed change-email link writes one applied row, not two", async () => {
    await t.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, adaId));
    await change();
    const link = linkIn(mail.last(NEW, "Confirm your email"));
    await auth.handler(clickLink(link, cookie));
    await auth.handler(clickLink(link, cookie));
    await auth.handler(clickLink(link));
    const applied = (await t.db.select().from(auditLog)).filter(
      (r) =>
        r.action === "user.email.update" &&
        (r.after as { stage?: string }).stage === "applied",
    );
    expect(applied).toHaveLength(1);
  });

  it("an address that belongs to someone else changes nothing, and the audit says so", async () => {
    await auth.handler(signUpRequest("taken@example.test"));
    const response = await auth.handler(
      authPost("/change-email", { newEmail: "taken@example.test" }, { cookie }),
    );
    expect(response.status).toBe(200);
    expect((await ada()).email).toBe(OLD);
    const rows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === "user.email.update",
    );
    expect(rows[0]?.after).toMatchObject({
      stage: "requested",
      applied: false,
    });
  });

  it("a .invalid address is refused", async () => {
    const response = await auth.handler(
      authPost(
        "/change-email",
        { newEmail: "ghost@example.invalid" },
        { cookie },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("ghost@example.invalid");
    expect((await ada()).email).toBe(OLD);
  });

  it("changing the password is audited without the passwords", async () => {
    const response = await auth.handler(
      authPost(
        "/change-password",
        { currentPassword: PASSWORD, newPassword: "another long password" },
        { cookie },
      ),
    );
    expect(response.status).toBe(200);
    const rows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === "user.password.update",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: adaId, entityId: adaId });
    expect(JSON.stringify(rows)).not.toContain("another long password");
  });

  it("a password reset is audited", async () => {
    await auth.handler(authPost("/request-password-reset", { email: OLD }));
    const token = new URL(linkIn(mail.last(OLD, "Reset your"))).pathname
      .split("/")
      .pop()!;
    await auth.handler(
      authPost("/reset-password", {
        newPassword: "a brand new password",
        token,
      }),
    );
    const rows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === "user.password.update",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: adaId, entityId: adaId });
  });
});
