// A stewards' time penalty, applied to a recorded Jolpica race body (HLD §12,
// the injected late penalty). Jolpica shapes only: this is adapter code.

interface RaceRow {
  position: string;
  positionText: string;
  points: string;
  laps: string;
  Driver: { driverId: string };
  Time?: { millis?: string; time?: string };
}

interface RaceBody {
  MRData: { RaceTable: { Races: Array<{ Results: RaceRow[] }> } };
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** `1:35:16.650`, or `35:16.650` under an hour (the winner's total time). */
function formatTotal(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return h > 0
    ? `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`
    : `${m}:${pad(s, 2)}.${pad(milli, 3)}`;
}

/** `+13.078`, `+1:19.183`: the gap to the winner. */
function formatGap(ms: number): string {
  if (ms < 60_000) return `+${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)}`;
  return `+${formatTotal(ms)}`;
}

/**
 * Returns a copy of `body` with `seconds` added to `driverId`'s race time and
 * the classification redone as far as the recorded values allow:
 *
 * - the driver moves down past every car on the same lap that is now ahead
 *   of them (never past a car with fewer laps, or one with no time);
 * - positions are renumbered, `positionText` follows for classified rows, and
 *   each position keeps the points the recorded body gave that slot;
 * - `Time.time` is rewritten as the winner's total and the others' gaps.
 *
 * Throws for a driver who is not in the body or has no race time.
 */
export function applyPenalty<T>(body: T, driverId: string, seconds: number): T {
  const copy = structuredClone(body) as T & RaceBody;
  const rows = copy.MRData.RaceTable.Races[0]?.Results;
  if (!rows) throw new Error("penalty: the body has no race results");
  const from = rows.findIndex((r) => r.Driver.driverId === driverId);
  const driver = rows[from];
  if (!driver) throw new Error(`penalty: ${driverId} is not in the results`);
  if (driver.Time?.millis === undefined) {
    throw new Error(`penalty: ${driverId} has no race time to add to`);
  }

  const millis = Number(driver.Time.millis) + Math.round(seconds * 1000);
  driver.Time.millis = String(millis);
  const slotPoints = rows.map((r) => r.points);

  let to = from;
  for (;;) {
    const next = rows[to + 1];
    const nextMillis = next?.Time?.millis;
    if (next === undefined || nextMillis === undefined) break;
    const sameLap = Number(next.laps) === Number(driver.laps);
    if (!sameLap || Number(nextMillis) >= millis) break;
    to++;
  }
  rows.splice(from, 1);
  rows.splice(to, 0, driver);

  const winnerMillis = Number(rows[0]?.Time?.millis);
  rows.forEach((row, i) => {
    row.position = String(i + 1);
    if (/^\d+$/.test(row.positionText)) row.positionText = row.position;
    row.points = slotPoints[i]!;
    if (row.Time?.millis !== undefined && !Number.isNaN(winnerMillis)) {
      const ms = Number(row.Time.millis);
      row.Time.time = i === 0 ? formatTotal(ms) : formatGap(ms - winnerMillis);
    }
  });
  return copy;
}
