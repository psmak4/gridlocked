import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): the fantasy e2e harness.
// - POST `{ at }` resets the local database, sets the simulated clock to `at`
//   (a whole minute) and seeds and opens the 2026 game from the recorded
//   fixtures with our own starting prices. Returns `{ gameId }`.
// - DELETE `{ at }` resets it with no game and the clock at `at`: the site
//   before a game opens.
// - GET reports the seeded game and its rounds, for the harness's own spec.
// - PATCH `{ withdraw: "VER" }` withdraws that driver from the open event, as
//   staff would: the pool changing under an open builder.
// - PATCH `{ crowd: 60, joinCode? }` adds 60 accounts with saved teams (and
//   puts them in that league): a table long enough to page.
// - PATCH `{ teamChange: { code: "ALB", team: "haas" } }` opens a team change
//   in the review queue for the next event still to lock.
// - PATCH `{ stale: "ALB" }` disqualifies that driver from the latest scored
//   race with nothing re-scored: something for a scoring dry run to show.
// The flag is replaced at build time, so a normal build keeps the 404 and
// drops the rest. `test-hook-game` marks this handler for the CI build check.
const notFound = () => withNoStore(new Response("Not found", { status: 404 }));

const wholeMinute = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || at.getTime() % 60_000 !== 0 ? null : at;
};

const badAt = () =>
  withNoStore(
    new Response("`at` must be an ISO instant on a whole minute", {
      status: 400,
    }),
  );

/** The body's `at`, or null if it isn't a whole minute. */
async function atOf(request: Request): Promise<Date | null> {
  const body = (await request.json().catch(() => ({}))) as { at?: unknown };
  return wholeMinute(body.at);
}

async function seed(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") return notFound();
  const at = await atOf(request);
  if (!at) return badAt();
  const { seedTestGame } = await import("@/server/test-game");
  const { gameId } = await seedTestGame(at);
  return withNoStore(Response.json({ gameId, hook: "test-hook-game" }));
}

async function clear(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") return notFound();
  const at = await atOf(request);
  if (!at) return badAt();
  const { clearTestGame } = await import("@/server/test-game");
  await clearTestGame(at);
  return withNoStore(Response.json({ ok: true, hook: "test-hook-game" }));
}

async function state(): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") return notFound();
  const { testGameState } = await import("@/server/test-game");
  return withNoStore(
    Response.json({ ...(await testGameState()), hook: "test-hook-game" }),
  );
}

async function change(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") return notFound();
  const body = (await request.json().catch(() => ({}))) as {
    withdraw?: unknown;
    crowd?: unknown;
    joinCode?: unknown;
    stale?: unknown;
    teamChange?: { code?: unknown; team?: unknown };
  };
  if (
    typeof body.teamChange?.code === "string" &&
    typeof body.teamChange.team === "string"
  ) {
    const { teamChangeTestReview, HarnessError } =
      await import("@/server/test-game");
    try {
      const done = await teamChangeTestReview({
        code: body.teamChange.code,
        team: body.teamChange.team,
      });
      return withNoStore(Response.json({ ...done, hook: "test-hook-game" }));
    } catch (error) {
      if (error instanceof HarnessError) {
        return withNoStore(
          new Response(error.message, { status: error.status }),
        );
      }
      throw error;
    }
  }
  if (typeof body.stale === "string") {
    const { staleTestOverride, HarnessError } =
      await import("@/server/test-game");
    try {
      const done = await staleTestOverride(body.stale);
      return withNoStore(Response.json({ ...done, hook: "test-hook-game" }));
    } catch (error) {
      if (error instanceof HarnessError) {
        return withNoStore(
          new Response(error.message, { status: error.status }),
        );
      }
      throw error;
    }
  }
  if (typeof body.crowd === "number") {
    if (
      !Number.isInteger(body.crowd) ||
      body.crowd < 1 ||
      body.crowd > 200 ||
      (body.joinCode !== undefined && typeof body.joinCode !== "string")
    ) {
      return withNoStore(
        new Response("`crowd` must be 1 to 200, `joinCode` a string", {
          status: 400,
        }),
      );
    }
    const { addTestCrowd, HarnessError } = await import("@/server/test-game");
    try {
      const done = await addTestCrowd({
        count: body.crowd,
        joinCode: body.joinCode as string | undefined,
      });
      return withNoStore(Response.json({ ...done, hook: "test-hook-game" }));
    } catch (error) {
      if (error instanceof HarnessError) {
        return withNoStore(
          new Response(error.message, { status: error.status }),
        );
      }
      throw error;
    }
  }
  if (typeof body.withdraw !== "string") {
    return withNoStore(
      new Response("`withdraw` must be a driver code", { status: 400 }),
    );
  }
  const { withdrawTestDriver, HarnessError } =
    await import("@/server/test-game");
  try {
    const done = await withdrawTestDriver(body.withdraw);
    return withNoStore(Response.json({ ...done, hook: "test-hook-game" }));
  } catch (error) {
    if (error instanceof HarnessError) {
      return withNoStore(new Response(error.message, { status: error.status }));
    }
    throw error;
  }
}

export const Route = createFileRoute("/api/test/game")({
  server: {
    handlers: {
      POST: ({ request }) => seed(request),
      DELETE: ({ request }) => clear(request),
      GET: () => state(),
      PATCH: ({ request }) => change(request),
    },
  },
});
