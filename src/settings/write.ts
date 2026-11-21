/**
 * Settings staff may change (M8 Task 13): the feature flags, the results
 * poll schedule and the after-race re-checks. Each change is checked by the
 * key's schema and audited with only the fields that changed, before and
 * after. Flags are recorded as On and Off, as the screen says them.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { settings } from "@/db/schema";
import type { Db } from "@/db/types";
import { StaffError, staffReason } from "@/staff/errors";
import { audit, type StaffActor } from "@/staff/roster";
import { settingSchemas, type SettingKey, type SettingValue } from "./defaults";
import { getSetting } from "./index";

/** The keys the settings screen edits; the rest stay as they are. */
export const EDITABLE_SETTINGS = [
  "feature_flags",
  "poll_schedule",
  "finalizer_checks",
] as const satisfies readonly SettingKey[];
export type EditableSetting = (typeof EDITABLE_SETTINGS)[number];

/** The audit row's entity: a stable id per key, since keys aren't uuids. */
export function settingEntityId(key: string): string {
  const hex = createHash("sha1").update(`setting:${key}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

const shown = (value: unknown) =>
  typeof value === "boolean" ? (value ? "On" : "Off") : value;

/** The top-level fields that differ, each side as the audit row keeps it. */
function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const field of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field]))
      continue;
    was[field] = shown(before[field]);
    now[field] = shown(after[field]);
  }
  return { was, now };
}

/**
 * Sets `key` to `value` with a reason. Refused: a key not in
 * `EDITABLE_SETTINGS` (`forbidden`), a value its schema refuses (`invalid`),
 * a blank reason. The same value again writes nothing.
 */
export async function setSetting(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { key: string; value: unknown; reason: string },
): Promise<{ changed: boolean }> {
  if (!(EDITABLE_SETTINGS as readonly string[]).includes(input.key)) {
    throw new StaffError("forbidden", input.key);
  }
  const key = input.key as EditableSetting;
  const parsed = settingSchemas[key].safeParse(input.value);
  if (!parsed.success) throw new StaffError("invalid", key);
  const reason = staffReason(input.reason);
  const value = parsed.data as SettingValue<typeof key>;

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // One writer at a time per key: the row, or the key's advisory lock
    // while there is no row yet.
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`setting:${key}`}))`,
    );
    const before = await getSetting(t, key);
    const { was, now: after } = changes(
      before as Record<string, unknown>,
      value as Record<string, unknown>,
    );
    if (Object.keys(after).length === 0) return { changed: false };
    await t
      .insert(settings)
      .values({
        key,
        value,
        updatedBy: actor.userId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value,
          updatedBy: actor.userId ?? null,
          updatedAt: now,
          version: sql`${settings.version} + 1`,
        },
      });
    await writeAudit(t, now, {
      ...audit(actor, reason),
      action: "setting.update",
      entityType: "setting",
      entityId: settingEntityId(key),
      before: was,
      after,
    });
    return { changed: true };
  });
}
