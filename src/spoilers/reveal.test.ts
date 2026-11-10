import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { seedUser } from "../../tests/helpers/users";
import * as schema from "@/db/schema";
import { sessionWatchMarks } from "@/db/schema";
import type { Db } from "@/db/types";
import { scrubAccount } from "@/identity/delete";
import { buildExport } from "@/identity/export";
import { newId } from "@/lib/ids";
import {
  isRevealed,
  markWatched,
  revealedSessions,
  SPOILER_WINDOW_DAYS,
} from "./reveal";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date("2026-06-07T13:00:00Z");
const FOREIGN_KEY_VIOLATION = "23503";

describe("isRevealed (DM 5.7)", () => {
  const cases: {
    name: string;
    now: Date;
    watched: boolean;
    protection: boolean;
    revealed: boolean;
  }[] = [
    {
      name: "protection off",
      now: new Date(START.getTime() + HOUR),
      watched: false,
      protection: false,
      revealed: true,
    },
    {
      name: "watched",
      now: new Date(START.getTime() + HOUR),
      watched: true,
      protection: true,
      revealed: true,
    },
    {
      name: "6 days 23 hours after the start",
      now: new Date(START.getTime() + 6 * DAY + 23 * HOUR),
      watched: false,
      protection: true,
      revealed: false,
    },
    {
      name: "exactly 7 days after the start",
      now: new Date(START.getTime() + 7 * DAY),
      watched: false,
      protection: true,
      revealed: true,
    },
    {
      name: "not started",
      now: new Date(START.getTime() - 1),
      watched: false,
      protection: true,
      revealed: true,
    },
    {
      name: "at the start",
      now: START,
      watched: false,
      protection: true,
      revealed: false,
    },
  ];

  it("has a 7-day window", () => {
    expect(SPOILER_WINDOW_DAYS).toBe(7);
  });

  it.each(cases)("$name", ({ now, watched, protection, revealed }) => {
    expect(isRevealed({ sessionStart: START, now, watched, protection })).toBe(
      revealed,
    );
  });
});

describe("watch marks (DM 5.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
  });
  afterEach(async () => {
    await t.close();
  });

  const seedSessions = (...starts: Date[]) => seedEventSessions(db, ...starts);

  const reader = (userId: string, spoilerProtection = true) => ({
    userId,
    spoilerProtection,
  });

  it("a logged-out reader sees only sessions past the window", async () => {
    const now = new Date(START.getTime() + 8 * DAY);
    const [old, recent, upcoming] = await seedSessions(
      START,
      new Date(now.getTime() - 2 * DAY),
      new Date(now.getTime() + DAY),
    );
    const userId = await seedUser(db);
    // Someone else's mark changes nothing for a logged-out reader.
    await markWatched(db, now, { userId, sessionIds: [recent!] });

    const revealed = await revealedSessions(db, now, null, [
      old!,
      recent!,
      upcoming!,
    ]);
    expect(revealed).toEqual(new Set([old, upcoming]));
  });

  it("a signed-in reader sees what they marked, and only that", async () => {
    const now = new Date(START.getTime() + DAY);
    const [qualifying, race] = await seedSessions(
      START,
      new Date(START.getTime() + HOUR),
    );
    const me = await seedUser(db);
    const other = await seedUser(db);
    await markWatched(db, now, { userId: me, sessionIds: [qualifying!] });
    await markWatched(db, now, { userId: other, sessionIds: [race!] });

    expect(
      await revealedSessions(db, now, reader(me), [qualifying!, race!]),
    ).toEqual(new Set([qualifying]));
  });

  it("with spoiler protection off, every session is revealed", async () => {
    const now = new Date(START.getTime() + DAY);
    const ids = await seedSessions(START, new Date(START.getTime() + HOUR));
    const me = await seedUser(db);

    expect(await revealedSessions(db, now, reader(me, false), ids)).toEqual(
      new Set(ids),
    );
  });

  it("an id that isn't a session is never revealed", async () => {
    const me = await seedUser(db);
    expect(
      await revealedSessions(db, START, reader(me, false), [newId()]),
    ).toEqual(new Set());
  });

  it("one query for many sessions", async () => {
    const now = new Date(START.getTime() + DAY);
    const ids = await seedSessions(
      START,
      new Date(START.getTime() + HOUR),
      new Date(START.getTime() + 2 * HOUR),
      new Date(START.getTime() + 3 * HOUR),
      new Date(START.getTime() + 4 * HOUR),
    );
    const me = await seedUser(db);
    await markWatched(db, now, { userId: me, sessionIds: ids.slice(0, 2) });

    const sent: string[] = [];
    const counted = drizzle(t.client, {
      schema,
      logger: { logQuery: (query) => sent.push(query) },
    }) as unknown as Db;
    const revealed = await revealedSessions(counted, now, reader(me), ids);
    expect(revealed).toEqual(new Set(ids.slice(0, 2)));
    expect(sent).toHaveLength(1);

    sent.length = 0;
    await revealedSessions(counted, now, null, ids);
    expect(sent).toHaveLength(1);

    sent.length = 0;
    expect(await revealedSessions(counted, now, reader(me), [])).toEqual(
      new Set(),
    );
    expect(sent).toHaveLength(0);
  });

  it("marking twice keeps one row", async () => {
    const [race] = await seedSessions(START);
    const me = await seedUser(db);
    const first = new Date(START.getTime() + DAY);
    await markWatched(db, first, { userId: me, sessionIds: [race!, race!] });
    await markWatched(db, new Date(first.getTime() + HOUR), {
      userId: me,
      sessionIds: [race!],
    });

    const rows = await db
      .select()
      .from(sessionWatchMarks)
      .where(eq(sessionWatchMarks.userId, me));
    expect(rows).toEqual([{ userId: me, sessionId: race, markedAt: first }]);
  });

  it("a watch mark needs a real user and session", async () => {
    const [race] = await seedSessions(START);
    const me = await seedUser(db);
    const code = async (promise: Promise<unknown>) => {
      const error = (await promise.then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: string; cause?: { code?: string } } | undefined;
      return error?.code ?? error?.cause?.code;
    };

    expect(
      await code(
        markWatched(db, START, { userId: newId(), sessionIds: [race!] }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await code(markWatched(db, START, { userId: me, sessionIds: [newId()] })),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("an export lists watched sessions", async () => {
    const [qualifying, race] = await seedSessions(
      START,
      new Date(START.getTime() + DAY),
    );
    const me = await seedUser(db);
    const markedAt = new Date(START.getTime() + 2 * DAY);
    await markWatched(db, markedAt, {
      userId: me,
      sessionIds: [race!, qualifying!],
    });

    const data = await buildExport(db, me);
    expect(data.watched_sessions).toEqual([
      {
        event: "2026-monaco",
        session: "fp1",
        sequence: 1,
        markedAt: markedAt.toISOString(),
      },
      {
        event: "2026-monaco",
        session: "fp2",
        sequence: 1,
        markedAt: markedAt.toISOString(),
      },
    ]);
  });

  it("deleting an account removes its marks", async () => {
    const [race] = await seedSessions(START);
    const me = await seedUser(db);
    const other = await seedUser(db);
    await markWatched(db, START, { userId: me, sessionIds: [race!] });
    await markWatched(db, START, { userId: other, sessionIds: [race!] });

    await scrubAccount(db, START, {
      userId: me,
      actor: { kind: "user", userId: me, label: null },
    });

    const rows = await db.select().from(sessionWatchMarks);
    expect(rows.map((r) => r.userId)).toEqual([other]);
  });
});
