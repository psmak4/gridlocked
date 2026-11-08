/**
 * The browser's side of Better Auth. Plugins join as the tasks that need them
 * land (two-factor).
 */
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});
