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
