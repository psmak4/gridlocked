import { z } from "zod";
import type { RosterConstructor, RosterDriver } from "@/reference/roster-types";

// Jolpica's `/{year}/drivers.json` and `/{year}/constructors.json` -> our own
// shapes. Nothing outside src/providers sees these key names.

/** Our team codes (src/design/tokens.ts) by Jolpica constructor id. */
const teamCodes: Readonly<Record<string, string>> = {
  alpine: "ALP",
  aston_martin: "AST",
  audi: "AUD",
  cadillac: "CAD",
  ferrari: "FER",
  haas: "HAA",
  mclaren: "MCL",
  mercedes: "MER",
  rb: "RB",
  red_bull: "RBR",
  williams: "WIL",
};

const driversBody = z.object({
  MRData: z.object({
    DriverTable: z.object({
      Drivers: z.array(
        z.object({
          driverId: z.string().min(1),
          givenName: z.string().min(1),
          familyName: z.string().min(1),
          code: z.string().min(1).optional(),
          permanentNumber: z.string().regex(/^\d+$/).optional(),
          dateOfBirth: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          nationality: z.string().optional(),
        }),
      ),
    }),
  }),
});

const constructorsBody = z.object({
  MRData: z.object({
    ConstructorTable: z.object({
      Constructors: z.array(
        z.object({
          constructorId: z.string().min(1),
          name: z.string().min(1),
          nationality: z.string().optional(),
        }),
      ),
    }),
  }),
});

/** Throws when the response is not a driver list. */
export function parseJolpicaDrivers(body: unknown): RosterDriver[] {
  return driversBody.parse(body).MRData.DriverTable.Drivers.map((d) => ({
    key: d.driverId,
    givenName: d.givenName,
    familyName: d.familyName,
    code: d.code ?? null,
    permanentNumber:
      d.permanentNumber === undefined ? null : Number(d.permanentNumber),
    nationality: d.nationality ?? "",
    dateOfBirth: d.dateOfBirth ?? null,
  }));
}

/** Throws when the response is not a constructor list. */
export function parseJolpicaConstructors(body: unknown): RosterConstructor[] {
  return constructorsBody
    .parse(body)
    .MRData.ConstructorTable.Constructors.map((c) => ({
      key: c.constructorId,
      name: c.name,
      nationality: c.nationality ?? "",
      teamCode: teamCodes[c.constructorId] ?? null,
    }));
}
