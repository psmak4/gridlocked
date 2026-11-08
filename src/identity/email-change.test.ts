import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  clickLink,
  cookieHeader,
  linkIn,
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
});
