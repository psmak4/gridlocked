import type { CalendarSyncSource } from "@/jobs/ports";
import { syncCalendar } from "@/reference/sync-calendar";
import { syncConstructors, syncDrivers } from "@/reference/sync-roster";
import type { ProviderClient, ProviderRequest } from "../http/client";
import { parseJolpicaCalendar } from "../jolpica/calendar";
import {
  parseJolpicaConstructors,
  parseJolpicaDrivers,
} from "../jolpica/roster";

const LIMIT = 100;

/**
 * The three questions a calendar sync asks of Jolpica, in order. The import
 * stores recorded answers under the same endpoint and params.
 */
export function jolpicaCalendarRequests(season: number): {
  calendar: ProviderRequest;
  drivers: ProviderRequest;
  constructors: ProviderRequest;
} {
  const params = { limit: String(LIMIT) };
  return {
    calendar: { endpoint: `/${season}.json`, params },
    drivers: { endpoint: `/${season}/drivers.json`, params },
    constructors: { endpoint: `/${season}/constructors.json`, params },
  };
}

/** `MRData.total`, so a list longer than one page is an error, not a cut-off. */
function assertOnePage(endpoint: string, body: unknown) {
  const total = Number(
    (body as { MRData?: { total?: string } } | null)?.MRData?.total ?? 0,
  );
  if (total > LIMIT) {
    throw new Error(
      `Jolpica ${endpoint}: ${total} items need more than a page`,
    );
  }
}

/**
 * The calendar sync port over Jolpica: `/{season}.json`,
 * `/{season}/drivers.json` and `/{season}/constructors.json`, each applied
 * with its sync function (which keeps admin-set fields, DM 1.3, 1.5). A
 * provider outage fails the job, and the runner retries it.
 */
export function createJolpicaCalendarSource(
  client: ProviderClient,
): CalendarSyncSource {
  return {
    async sync(db, clock, season, jobId) {
      const requests = jolpicaCalendarRequests(season);
      const get = async ({ endpoint, params }: ProviderRequest) => {
        const res = await client.get(endpoint, params, { jobId });
        assertOnePage(endpoint, res.body);
        return res;
      };
      const calendar = await get(requests.calendar);
      const drivers = await get(requests.drivers);
      const constructors = await get(requests.constructors);

      await syncCalendar(db, clock, season, {
        events: parseJolpicaCalendar(calendar.body),
        snapshotId: calendar.snapshotId,
      });
      await syncDrivers(db, clock, season, {
        items: parseJolpicaDrivers(drivers.body),
        snapshotId: drivers.snapshotId,
      });
      await syncConstructors(db, clock, season, {
        items: parseJolpicaConstructors(constructors.body),
        snapshotId: constructors.snapshotId,
      });
    },
  };
}
