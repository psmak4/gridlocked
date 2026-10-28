// Deliberately violates the provider import boundary. Excluded from
// `pnpm lint`; linted only by tests/lint/provider-boundary.test.ts.
import { createProviderClient } from "@/providers/http/client";

export const client = createProviderClient;
