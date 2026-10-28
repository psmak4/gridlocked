// Deliberately violates the no-direct-time rule. Excluded from `pnpm lint`;
// linted only by tests/lint/no-direct-time.test.ts.
export const stamp = Date.now();
export const today = new Date();
export const asString = Date();
// Allowed: constructing a Date from an argument is not a time read.
export const fixed = new Date(0);
