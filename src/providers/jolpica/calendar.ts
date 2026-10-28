import { z } from "zod";
import type {
  CalendarEvent,
  CalendarSession,
  EventFormat,
  SessionKind,
} from "@/reference/calendar-types";
import { circuitTimezones } from "./circuit-timezones";

// Jolpica's season endpoint (`/{year}.json`) -> our CalendarEvent shape.
// Nothing outside src/providers sees these key names.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoTime = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

const sessionBlock = z.object({ date: isoDate, time: isoTime.optional() });

const race = z.object({
  season: z.string().regex(/^\d{4}$/),
  round: z.string().regex(/^\d+$/),
  raceName: z.string().min(1),
  date: isoDate,
  time: isoTime.optional(),
  Circuit: z.object({
    circuitId: z.string().min(1),
    circuitName: z.string().min(1),
    Location: z.object({
      lat: decimal,
      long: decimal,
      locality: z.string(),
      country: z.string(),
    }),
  }),
  FirstPractice: sessionBlock.optional(),
  SecondPractice: sessionBlock.optional(),
  ThirdPractice: sessionBlock.optional(),
  SprintQualifying: sessionBlock.optional(),
  // The 2023 name for sprint qualifying.
  SprintShootout: sessionBlock.optional(),
  Sprint: sessionBlock.optional(),
  Qualifying: sessionBlock.optional(),
});

const calendarBody = z.object({
  MRData: z.object({ RaceTable: z.object({ Races: z.array(race) }) }),
});

type Block = z.infer<typeof sessionBlock>;

const KIND_ORDER: SessionKind[] = [
  "fp1",
  "fp2",
  "fp3",
  "sprint_qualifying",
  "sprint",
  "qualifying",
  "race",
];

/** A date and optional time -> an instant. No time means a date only. */
function toSession(kind: SessionKind, block: Block): CalendarSession {
  const confirmed = block.time !== undefined;
  const time = block.time ?? "00:00:00Z";
  // Jolpica times end in Z. A time with no zone is read as UTC as well.
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(time) ? time : `${time}Z`;
  const start = new Date(`${block.date}T${zoned}`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Unreadable ${kind} start: ${block.date} ${time}`);
  }
  return { kind, start, confirmed };
}

/**
 * Parses a Jolpica season calendar. Throws when the response is not one: a
 * calendar we half understand must not be synced.
 */
export function parseJolpicaCalendar(body: unknown): CalendarEvent[] {
  const parsed = calendarBody.parse(body);
  return parsed.MRData.RaceTable.Races.map((r) => {
    const blocks: Array<[SessionKind, Block | undefined]> = [
      ["fp1", r.FirstPractice],
      ["fp2", r.SecondPractice],
      ["fp3", r.ThirdPractice],
      ["sprint_qualifying", r.SprintQualifying ?? r.SprintShootout],
      ["sprint", r.Sprint],
      ["qualifying", r.Qualifying],
      ["race", { date: r.date, time: r.time }],
    ];
    const sessions = blocks
      .flatMap(([kind, block]) => (block ? [toSession(kind, block)] : []))
      .sort(
        (a, b) =>
          a.start.getTime() - b.start.getTime() ||
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
      );
    const format: EventFormat = r.Sprint ? "sprint" : "standard";
    const circuit = r.Circuit;
    return {
      key: `${r.season}/${r.round}`,
      round: Number(r.round),
      name: r.raceName,
      raceDate: r.date,
      format,
      circuit: {
        key: circuit.circuitId,
        name: circuit.circuitName,
        locality: circuit.Location.locality,
        country: circuit.Location.country,
        latitude: circuit.Location.lat,
        longitude: circuit.Location.long,
        timezone: circuitTimezones[circuit.circuitId] ?? null,
      },
      sessions,
    };
  });
}
