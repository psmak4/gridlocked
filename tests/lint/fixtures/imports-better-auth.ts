// Deliberately violates the Better Auth import boundary. Excluded from
// `pnpm lint`; linted only by tests/lint/better-auth-boundary.test.ts.
import { betterAuth } from "better-auth";

export const auth = betterAuth;
