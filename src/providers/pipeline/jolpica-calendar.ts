import type { CalendarSyncSource } from "@/jobs/ports";
import { syncCalendar } from "@/reference/sync-calendar";
import { syncConstructors, syncDrivers } from "@/reference/sync-roster";
import type { ProviderClient } from "../http/client";
import { parseJolpicaCalendar } from "../jolpica/calendar";
import {
  parseJolpicaConstructors,
  parseJolpicaDrivers,
} from "../jolpica/roster";

const LIMIT = 100;

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
      const get = async (endpoint: string) => {
        const res = await client.get(
          endpoint,
          { limit: String(LIMIT) },
          {
            jobId,
          },
        );
        assertOnePage(endpoint, res.body);
        return res;
      };
      const calendar = await get(`/${season}.json`);
      const drivers = await get(`/${season}/drivers.json`);
      const constructors = await get(`/${season}/constructors.json`);

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
