import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { resultOverrides, results } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

// The admin layer over provider rows (DM 2.6). An override is stored as an
// event: made, then revoked, never edited, so history stays readable.

/** Columns of `results` an override can never set: identity and provenance. */
const NOT_OVERRIDABLE = [
  "session_id",
  "driver_id",
  "snapshot_id",
  "session_kind",
] as const;

type Snake<S extends string> = S extends `${infer H}${infer T}`
  ? `${H extends Lowercase<H> ? H : `_${Lowercase<H>}`}${Snake<T>}`
  : S;

/**
 * The fields an override can set, under `results`' own column names. A
 * column that is NOT NULL in `results` cannot be set to null here either.
 */
export type ResultFields = {
  [
    K in keyof typeof results.$inferSelect as Snake<
      K & string
    > extends (typeof NOT_OVERRIDABLE)[number]
      ? never
      : Snake<K & string>
  ]?: (typeof results.$inferSelect)[K];
};

/** A Zod type for one `results` column, nullable only where the column is. */
function fieldFor(column: ReturnType<typeof getTableColumns>[string]) {
  let field: z.ZodType;
  switch (column.columnType) {
    case "PgInteger":
    case "PgBigInt53":
      field = z.number().int().nonnegative();
      break;
    case "PgBoolean":
      field = z.boolean();
      break;
    case "PgUUID":
      field = z.uuid();
      break;
    case "PgNumeric":
      // numeric(4,1), as a string the way the column reads back ("25.0").
      field = z.string().regex(/^\d{1,3}(\.\d)?$/);
      break;
    case "PgText":
      field = column.enumValues
        ? z.enum(column.enumValues as [string, ...string[]])
        : z.string().min(1);
      break;
    default:
      throw new Error(
        `no override schema for ${column.name} (${column.columnType})`,
      );
  }
  return (column.notNull ? field : field.nullable()).optional();
}

/**
 * Generated from the `results` columns, so the two cannot drift apart: a new
 * column appears here with its type, and a NOT NULL column rejects `null`.
 * Unknown keys are an error.
 */
export const resultFieldsSchema = z.strictObject(
  Object.fromEntries(
    Object.values(getTableColumns(results))
      .filter((c) => !(NOT_OVERRIDABLE as readonly string[]).includes(c.name))
      .map((c) => [c.name, fieldFor(c)]),
  ),
) as unknown as z.ZodType<ResultFields>;

/** Keys `effective_results` cannot fill in, so an `insert` must carry them. */
const INSERT_REQUIRED = [
  "constructor_id",
  "car_number",
  "classification",
  "provider_status",
  "provider_position_text",
] as const;

function checkFields(
  kind: "patch" | "insert" | "suppress",
  fields: ResultFields | undefined,
): ResultFields {
  if (kind === "suppress") {
    if (fields !== undefined && Object.keys(fields).length > 0) {
      throw new Error("a suppress override takes no fields");
    }
    return {};
  }
  const parsed = resultFieldsSchema.safeParse(fields ?? {});
  if (!parsed.success) {
    throw new Error(
      `invalid override fields: ${z.prettifyError(parsed.error)}`,
    );
  }
  // `undefined` values vanish in JSON, so they do not count as keys.
  const clean = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  ) as ResultFields;
  if (kind === "patch" && Object.keys(clean).length === 0) {
    throw new Error("a patch override needs at least one field");
  }
  if (kind === "insert") {
    const missing = INSERT_REQUIRED.filter((k) => !(k in clean));
    if (missing.length > 0) {
      throw new Error(`an insert override needs ${missing.join(", ")}`);
    }
  }
  return clean;
}

/**
 * Adds an override and returns its id. Any active override for the same
 * driver in the session is revoked first, in the same transaction, so there
 * is only ever one (DM 2.6): editing is revoke-and-replace. `now` stamps both
 * the revocation and the new row; `createdBy` is recorded as the revoker.
 */
export async function addOverride(
  db: Db,
  now: Date,
  o: {
    sessionId: string;
    driverId: string;
    kind: "patch" | "insert" | "suppress";
    fields?: ResultFields;
    reason: string;
    createdBy: string;
  },
): Promise<string> {
  const fields = checkFields(o.kind, o.fields);
  if (o.reason.trim() === "") throw new Error("an override needs a reason");
  return db.transaction(async (tx) => {
    await tx
      .update(resultOverrides)
      .set({
        revokedAt: now,
        revokedBy: o.createdBy,
        version: sql`${resultOverrides.version} + 1`,
      })
      .where(
        and(
          eq(resultOverrides.sessionId, o.sessionId),
          eq(resultOverrides.driverId, o.driverId),
          isNull(resultOverrides.revokedAt),
        ),
      );
    const id = newId();
    await tx.insert(resultOverrides).values({
      id,
      sessionId: o.sessionId,
      driverId: o.driverId,
      kind: o.kind,
      fields,
      reason: o.reason,
      createdBy: o.createdBy,
      createdAt: now,
    });
    return id;
  });
}

/** Revokes an override, reverting that driver to the provider value. */
export async function revokeOverride(
  db: Db,
  now: Date,
  id: string,
  by: string,
): Promise<void> {
  const revoked = await db
    .update(resultOverrides)
    .set({
      revokedAt: now,
      revokedBy: by,
      version: sql`${resultOverrides.version} + 1`,
    })
    .where(and(eq(resultOverrides.id, id), isNull(resultOverrides.revokedAt)))
    .returning({ id: resultOverrides.id });
  if (revoked.length > 0) return;
  const [existing] = await db
    .select({ id: resultOverrides.id })
    .from(resultOverrides)
    .where(eq(resultOverrides.id, id));
  throw new Error(
    existing ? `override ${id} is already revoked` : `no override ${id}`,
  );
}
