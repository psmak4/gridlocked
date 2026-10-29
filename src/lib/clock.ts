/**
 * The injectable clock. Every "now" read in the app goes through a Clock so
 * that replay and tests can control time. This is the only module allowed to
 * read the real time (enforced by ESLint, see eslint.config.mjs).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  const time = at.getTime();
  return { now: () => new Date(time) };
}

export function simulatedClock(
  start: Date,
): Clock & { advance(ms: number): void; set(at: Date): void } {
  let time = start.getTime();
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
    set(at: Date) {
      time = at.getTime();
    },
  };
}

/**
 * Elapsed time and waiting, apart from the `Clock`. A `Clock` is the instant
 * the app treats as "now" (frozen for a whole tick, or simulated in a replay);
 * a `Timer` is real time passing: how long a call took, how long to wait, how
 * long ago something happened. `now()` is epoch milliseconds, so it can be
 * compared with a stored timestamp.
 */
export interface Timer {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemTimer: Timer = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * A timer for tests and replays: it reads `clock`, and a sleep moves it
 * forward by that much without waiting, so a rate limiter that has to wait
 * sees the time pass and the run stays instant.
 */
export function virtualTimer(clock: Clock): Timer {
  let slept = 0;
  return {
    now: () => clock.now().getTime() + slept,
    sleep: async (ms) => {
      slept += ms;
    },
  };
}
