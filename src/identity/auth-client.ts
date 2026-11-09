/**
 * The browser's side of Better Auth: magic links, and the two-factor
 * endpoints the security page uses to set up an authenticator (staff only).
 */
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), twoFactorClient()],
});
