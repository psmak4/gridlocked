import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Spike: the browser side of Better Auth, on this page's own origin. */
export const authClient = createAuthClient({ plugins: [adminClient()] });
