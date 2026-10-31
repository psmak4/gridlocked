import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { auditLog } from "@/db/schema";
import { writeAudit, type AuditEntry } from "./log";

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
});
