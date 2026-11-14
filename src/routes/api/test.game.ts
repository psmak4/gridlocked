import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): the fantasy e2e harness.
// - POST `{ at }` resets the local database, sets the simulated clock to `at`
//   (a whole minute) and seeds and opens the 2026 game from the recorded
//   fixtures with our own starting prices. Returns `{ gameId }`.
// - DELETE `{ at }` resets it with no game and the clock at `at`: the site
//   before a game opens.
// - GET reports the seeded game and its rounds, for the harness's own spec.
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

export const Route = createFileRoute("/api/test/game")({
  server: {
    handlers: {
      POST: ({ request }) => seed(request),
      DELETE: ({ request }) => clear(request),
      GET: () => state(),
    },
  },
});
