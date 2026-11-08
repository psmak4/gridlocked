import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { auditLog } from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { writeAudit, redactPersonal, type AuditEntry } from "./log";

const NOW = new Date("2026-11-02T09:00:00.000Z");
const ENTRY: AuditEntry = {
  actorKind: "admin",
  actorLabel: "psmak4",
  action: "event_entry.create",
  entityType: "event_entry",
  entityId: "01a18914-1937-780c-81c0-ce3aefb154b6",
  before: null,
  after: { constructorId: "haas", carNumber: 99, source: "admin" },
  reason: "Hirakawa replaces Ocon for the Mexico City weekend",
  requestId: "gh-run:1",
};

describe("writeAudit", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("writes one row with the given fields", async () => {
    await writeAudit(t.db, NOW, ENTRY);
    const rows = await t.db.select().from(auditLog);
    expect(rows).toEqual([
      {
        id: expect.any(String),
        actorUserId: null,
        impersonatingUserId: null,
        ...ENTRY,
        createdAt: NOW,
      },
    ]);
  });

  it("an update is refused", async () => {
    await writeAudit(t.db, NOW, ENTRY);
    await expect(
      t.client.query(`update audit_log set reason = 'rewritten'`),
    ).rejects.toThrow(/append-only/);
  });

  it("a delete is refused", async () => {
    await writeAudit(t.db, NOW, ENTRY);
    await expect(t.client.query("delete from audit_log")).rejects.toThrow(
      /append-only/,
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it("an email inside before or after is stored redacted, at any depth", async () => {
    const id = await writeAudit(t.db, NOW, {
      ...ENTRY,
      before: { email: "a@example.com", keep: 1 },
      after: {
        nested: { ip: "203.0.113.9", list: [{ userAgent: "x", ok: true }] },
        name: "Ada",
        ipAddress: "::1",
      },
    });
    const [row] = await t.db.select().from(auditLog);
    expect(row!.id).toBe(id);
    expect(row!.before).toEqual({ email: "[redacted]", keep: 1 });
    expect(row!.after).toEqual({
      nested: {
        ip: "[redacted]",
        list: [{ userAgent: "[redacted]", ok: true }],
      },
      name: "[redacted]",
      ipAddress: "[redacted]",
    });
  });

  it("a Date inside before or after is kept as it was", async () => {
    const when = new Date("2026-12-01T10:00:00.000Z");
    expect(redactPersonal({ banExpires: when, list: [when] })).toEqual({
      banExpires: when,
      list: [when],
    });
    await writeAudit(t.db, NOW, { ...ENTRY, after: { banExpires: when } });
    const [row] = await t.db.select().from(auditLog);
    expect(row!.after).toEqual({ banExpires: when.toISOString() });
  });

  it("redactPersonal leaves its input alone", () => {
    const input = { a: { email: "a@example.com" } };
    expect(redactPersonal(input)).toEqual({ a: { email: "[redacted]" } });
    expect(input).toEqual({ a: { email: "a@example.com" } });
  });

  it("an audit row can name its user and the user it impersonated", async () => {
    const actor = await seedUser(t.db);
    const target = await seedUser(t.db);
    await writeAudit(t.db, NOW, {
      ...ENTRY,
      actorUserId: actor,
      impersonatingUserId: target,
    });
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      actorUserId: actor,
      impersonatingUserId: target,
    });
  });
});
