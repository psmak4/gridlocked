import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CLASSIFICATIONS, providerIds, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { resultFieldsSchema, type ResultFields } from "@/results/overrides";
import { SCORED_KINDS } from "@/results/validate";
import { insertResult, overrideResult } from "./results";
import { changeSeats, recordSubstitution, type StaffActor } from "./roster";
import type { SessionMove, StaffDeps } from "./revalidate";

// `pnpm staff` (scripts/staff.ts): the staff roster actions from the command
// line, until M8's screens. Everything but the command comes from the
// environment, so the staff-action workflow never writes an input into a
// shell command line. Keys are Jolpica's (`ocon`, `haas`, `2026/19`).

const text = (name: string) =>
  z
    .string({ message: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

const json = <T extends z.ZodType>(schema: T) =>
  z
    .string({ message: "STAFF_CHANGE is required" })
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "STAFF_CHANGE is not valid JSON",
        });
        return z.NEVER;
      }
    })
    .pipe(schema);

const carNumber = z.number().int().min(0).max(999);
const key = z.string().trim().min(1).max(64);

const substituteChange = z.strictObject({
  in: key,
  team: key,
  car: carNumber,
  out: key.nullable(),
});
const seatsChange = z
  .array(
    z.strictObject({
      driver: key,
      team: key.nullable(),
      car: carNumber.optional(),
    }),
  )
  .min(1)
  .max(10);
const overrideChange = z.strictObject({
  session: z.enum(SCORED_KINDS),
  driver: key,
  fields: resultFieldsSchema.refine((f) => Object.keys(f).length > 0, {
    message: "fields must set at least one column",
  }),
});
const insertChange = z.strictObject({
  session: z.enum(SCORED_KINDS),
  driver: key,
  team: key,
  car: carNumber,
  position: z.number().int().min(1).nullable(),
  classification: z.enum(CLASSIFICATIONS),
});

const common = {
  STAFF_EVENT: text("STAFF_EVENT").regex(
    /^\d{4}\/\d{1,2}$/,
    "STAFF_EVENT is season/round",
  ),
  STAFF_REASON: text("STAFF_REASON").pipe(z.string().max(500)),
  STAFF_ACTOR: text("STAFF_ACTOR").pipe(z.string().max(100)),
  STAFF_REQUEST_ID: z.string().max(200).optional(),
  STAFF_DRY_RUN: z.enum(["true", "false"]).default("true"),
};

export type StaffCommand =
  | {
      command: "substitute";
      event: string;
      change: z.infer<typeof substituteChange>;
      reason: string;
      actor: StaffActor;
      dryRun: boolean;
    }
  | {
      command: "seats";
      event: string;
      change: z.infer<typeof seatsChange>;
      reason: string;
      actor: StaffActor;
      dryRun: boolean;
    }
  | {
      command: "override";
      event: string;
      change: {
        session: (typeof SCORED_KINDS)[number];
        driver: string;
        fields: ResultFields;
      };
      reason: string;
      actor: StaffActor;
      dryRun: boolean;
    }
  | {
      command: "insert";
      event: string;
      change: {
        session: (typeof SCORED_KINDS)[number];
        driver: string;
        team: string;
        car: number;
        position: number | null;
        classification: (typeof CLASSIFICATIONS)[number];
      };
      reason: string;
      actor: StaffActor;
      dryRun: boolean;
    };

const COMMANDS = {
  substitute: substituteChange,
  seats: seatsChange,
  override: overrideChange,
  insert: insertChange,
} as const;

/**
 * Reads a staff command from the environment. Throws, naming the variable, on
 * anything missing or malformed. A run is a dry run unless STAFF_DRY_RUN is
 * exactly `false`.
 */
export function parseStaffEnv(
  command: string | undefined,
  env: Record<string, string | undefined>,
): StaffCommand {
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
    throw new Error(
      `unknown command ${command ?? "(none)"}: use ${Object.keys(COMMANDS).join(", ")}`,
    );
  }
  const name = command as keyof typeof COMMANDS;
  const schema = z.object({
    ...common,
    STAFF_CHANGE: json(COMMANDS[name] as z.ZodType),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) =>
          i.path.length ? `${String(i.path[0])}: ${i.message}` : i.message,
        )
        .join("; "),
    );
  }
  const e = parsed.data;
  const actor: StaffActor = {
    kind: "admin",
    label: e.STAFF_ACTOR,
    ...(e.STAFF_REQUEST_ID ? { requestId: e.STAFF_REQUEST_ID } : {}),
  };
  const base = {
    event: e.STAFF_EVENT,
    reason: e.STAFF_REASON,
    actor,
    dryRun: e.STAFF_DRY_RUN !== "false",
  };
  return { command: name, ...base, change: e.STAFF_CHANGE } as StaffCommand;
}

async function resolve(
  db: Db,
  entityType: "event" | "driver" | "constructor",
  providerKey: string,
): Promise<string> {
  const [row] = await db
    .select({ id: providerIds.entityId })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, "jolpica"),
        eq(providerIds.entityType, entityType),
        eq(providerIds.providerKey, providerKey),
      ),
    );
  if (!row) throw new Error(`no ${entityType} ${providerKey} (Jolpica key)`);
  return row.id;
}

/** The event's one session of `kind`; a sprint weekend has one of each. */
async function sessionOf(
  db: Db,
  eventId: string,
  event: string,
  kind: (typeof SCORED_KINDS)[number],
): Promise<string> {
  const found = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.eventId, eventId), eq(sessions.kind, kind)));
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `no ${kind} session at ${event}`
        : `${found.length} ${kind} sessions at ${event}`,
    );
  }
  return found[0]!.id;
}

export type StaffRunReport =
  | {
      dryRun: true;
      command: StaffCommand["command"];
      resolved: Record<string, unknown>;
    }
  | {
      dryRun: false;
      command: StaffCommand["command"];
      resolved: Record<string, unknown>;
      changed?: boolean;
      eventsSynced?: number;
      sessions: SessionMove[];
    };

/**
 * Resolves every key first (an unknown one throws before any write), then,
 * unless it is a dry run, runs the action.
 */
export async function runStaffCommand(
  db: Db,
  now: Date,
  cmd: StaffCommand,
  deps: StaffDeps = {},
): Promise<StaffRunReport> {
  const eventId = await resolve(db, "event", cmd.event);
  if (cmd.command === "substitute") {
    const resolved = {
      eventId,
      inDriverId: await resolve(db, "driver", cmd.change.in),
      constructorId: await resolve(db, "constructor", cmd.change.team),
      carNumber: cmd.change.car,
      outDriverId: cmd.change.out
        ? await resolve(db, "driver", cmd.change.out)
        : null,
    };
    if (cmd.dryRun) return { dryRun: true, command: cmd.command, resolved };
    const result = await recordSubstitution(
      db,
      now,
      {
        ...resolved,
        reason: cmd.reason,
        actor: cmd.actor,
      },
      deps,
    );
    return { dryRun: false, command: cmd.command, resolved, ...result };
  }

  if (cmd.command === "override") {
    const resolved = {
      sessionId: await sessionOf(db, eventId, cmd.event, cmd.change.session),
      driverId: await resolve(db, "driver", cmd.change.driver),
      fields: cmd.change.fields,
    };
    if (cmd.dryRun) return { dryRun: true, command: cmd.command, resolved };
    const result = await overrideResult(
      db,
      now,
      { ...resolved, reason: cmd.reason, actor: cmd.actor },
      deps,
    );
    return { dryRun: false, command: cmd.command, resolved, ...result };
  }

  if (cmd.command === "insert") {
    const resolved = {
      sessionId: await sessionOf(db, eventId, cmd.event, cmd.change.session),
      driverId: await resolve(db, "driver", cmd.change.driver),
      constructorId: await resolve(db, "constructor", cmd.change.team),
      carNumber: cmd.change.car,
      position: cmd.change.position,
      classification: cmd.change.classification,
    };
    if (cmd.dryRun) return { dryRun: true, command: cmd.command, resolved };
    const result = await insertResult(
      db,
      now,
      { ...resolved, reason: cmd.reason, actor: cmd.actor },
      deps,
    );
    return { dryRun: false, command: cmd.command, resolved, ...result };
  }

  const changes = [];
  for (const c of cmd.change) {
    changes.push({
      driverId: await resolve(db, "driver", c.driver),
      constructorId: c.team ? await resolve(db, "constructor", c.team) : null,
      ...(c.car === undefined ? {} : { carNumber: c.car }),
    });
  }
  const resolved = { fromEventId: eventId, changes };
  if (cmd.dryRun) return { dryRun: true, command: cmd.command, resolved };
  const result = await changeSeats(
    db,
    now,
    {
      ...resolved,
      reason: cmd.reason,
      actor: cmd.actor,
    },
    deps,
  );
  return { dryRun: false, command: cmd.command, resolved, ...result };
}
