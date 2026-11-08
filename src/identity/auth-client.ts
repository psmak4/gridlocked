/**
 * The browser's side of Better Auth. Plugins join as the tasks that need them
 * land (username, two-factor, magic link).
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
