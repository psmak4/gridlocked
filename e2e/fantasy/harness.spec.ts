import { expect, test } from "@playwright/test";
import {
  gameState,
  moveClock,
  ROUND_1,
  roundOf,
  seedGame,
} from "../helpers/game";

// The fantasy project: a VITE_LOCAL_DB=1 build in replay mode, one spec at a
// time (playwright.config). These check the harness itself; the screens'
// specs build on it.

test("seeding gives an open game with round 1 open and priced", async ({
  request,
}) => {
  const { gameId } = await seedGame(request, ROUND_1.beforeLock);

  const state = await gameState(request);
  expect(state.gameId).toBe(gameId);
  expect(state.now).toBe(ROUND_1.beforeLock);
  expect(state.status).toBe("open");
  const round1 = roundOf(state, 1);
  expect(round1.status).toBe("open");
  expect(round1.pool).toBeGreaterThan(0);
  expect(round1.prices).toBe(round1.pool);
  expect(round1.scoredSessions).toBe(0);
  expect(roundOf(state, 2).status).toBe("upcoming");
});

test("seeding again starts over", async ({ request }) => {
  const first = await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterLock);
  const second = await seedGame(request, ROUND_1.beforeLock);

  expect(second.gameId).not.toBe(first.gameId);
  const state = await gameState(request);
  expect(state.now).toBe(ROUND_1.beforeLock);
  expect(roundOf(state, 1).status).toBe("open");
});

test("moving the clock past round 1's lock locks it", async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);

  const moved = await moveClock(request, ROUND_1.afterLock);
  expect(moved.now).toBe(ROUND_1.afterLock);
  expect(moved.jobsRun).toBeGreaterThan(0);

  const state = await gameState(request);
  expect(state.now).toBe(ROUND_1.afterLock);
  expect(state.status).toBe("running");
  expect(roundOf(state, 1)).toMatchObject({
    status: "locked",
    scoredSessions: 0,
  });
});

test("moving it past the race scores round 1, and past +48 hours makes it final", async ({
  request,
}) => {
  await seedGame(request, ROUND_1.beforeLock);

  await moveClock(request, ROUND_1.afterQualifying);
  expect(roundOf(await gameState(request), 1)).toMatchObject({
    status: "scored",
    scoredSessions: 1,
  });

  await moveClock(request, ROUND_1.afterRace);
  let state = await gameState(request);
  expect(roundOf(state, 1)).toMatchObject({
    status: "scored",
    scoredSessions: 2,
  });
  expect(state.priceUpdates).toBe(0);

  await moveClock(request, ROUND_1.final);
  state = await gameState(request);
  expect(state.now).toBe(ROUND_1.final);
  expect(roundOf(state, 1).status).toBe("final");
  // The price job ran on round 1's scores: round 2 is priced by the formula.
  expect(state.priceUpdates).toBe(1);
  const round2 = roundOf(state, 2);
  expect(round2.prices).toBe(round2.pool);
});

test("the clock never moves back", async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterLock);

  const response = await request.post("/api/test/clock", {
    data: { to: ROUND_1.beforeLock },
  });
  expect(response.status()).toBe(400);
  expect((await gameState(request)).now).toBe(ROUND_1.afterLock);
});
