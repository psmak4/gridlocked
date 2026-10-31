// How many cars an event's entries put on track (DM 1.9). A mid-weekend
// substitute and the driver he replaces both have entries for the event, so
// a team can have three entries and still run only its two cars.

interface Entrant {
  driverId: string;
  constructorId: string;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function byConstructor(entries: readonly Entrant[]): Map<string, string[]> {
  const teams = new Map<string, string[]>();
  for (const e of entries) {
    teams.set(e.constructorId, [
      ...(teams.get(e.constructorId) ?? []),
      e.driverId,
    ]);
  }
  return teams;
}

/** The cars expected: per constructor, `min(its entries, carsPerConstructor)`. */
export function expectedCars(
  entries: readonly Entrant[],
  carsPerConstructor: number,
): number {
  let cars = 0;
  for (const drivers of byConstructor(entries).values()) {
    cars += Math.min(drivers.length, carsPerConstructor);
  }
  return cars;
}

/**
 * The entrants who are really missing: the absent ones of every constructor
 * with fewer present drivers than its expected cars. A team whose cars are
 * all accounted for has no missing driver, however many of its entrants sat
 * out. Sorted by driver id.
 */
export function absentEntrants(
  entries: readonly Entrant[],
  presentDriverIds: ReadonlySet<string>,
  carsPerConstructor: number,
): string[] {
  const missing: string[] = [];
  for (const drivers of byConstructor(entries).values()) {
    const present = drivers.filter((d) => presentDriverIds.has(d)).length;
    if (present >= Math.min(drivers.length, carsPerConstructor)) continue;
    missing.push(...drivers.filter((d) => !presentDriverIds.has(d)));
  }
  return missing.sort(byText);
}
