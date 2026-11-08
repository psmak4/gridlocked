import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { users, type UserRole } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import type { ServerDb } from "@/server/db";
import { getViewer } from "@/server/session";
import {
  authPost,
  cookieHeader,
  PASSWORD,
  signUpRequest,
  TEST_ORIGIN,
  testAuthEnv,
  type TestAuth,
} from "./auth";

// Helpers for the staff tests (DM 6.4). They need `vi.useFakeTimers({ toFake:
// ["Date"] })`: Better Auth reads its own clock for TOTP and expiry, and the
// tests move it in step with the `now` they pass to our code.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, as in an otpauth:// URI, back to the secret's text. */
export function base32Decode(text: string): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The TOTP code for `secret` at `at` (default: the current fake time), from
 * the two-factor plugin's own server-only `generateTOTP`, so it's the code an
 * authenticator app would show.
 */
export async function totpCode(
  auth: TestAuth,
  secret: string,
  at?: Date,
): Promise<string> {
  const previous = vi.getMockedSystemTime();
  if (at && !previous) throw new Error("totpCode(at) needs fake Date");
  if (at) vi.setSystemTime(at);
  try {
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    return code;
  } finally {
    if (at && previous) vi.setSystemTime(previous);
  }
}

export type TotpSetup = { secret: string; backupCodes: string[] };

/**
 * Turns TOTP on for the session in `cookie`: enable, then confirm with a
 * code. Confirming replaces the session, so the new cookie is returned.
 */
export async function enableTotp(
  auth: TestAuth,
  cookie: string,
  body: { password?: string } = {},
): Promise<TotpSetup & { cookie: string }> {
  const enabled = await auth.handler(
    authPost("/two-factor/enable", body, { cookie }),
  );
  if (enabled.status !== 200) {
    throw new Error(`two-factor/enable answered ${enabled.status}`);
  }
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const encoded = new URL(totpURI).searchParams.get("secret");
  if (!encoded) throw new Error("no secret in the TOTP URI");
  const secret = base32Decode(encoded);
  const confirmed = await auth.handler(
    authPost(
      "/two-factor/verify-totp",
      { code: await totpCode(auth, secret) },
      { cookie },
    ),
  );
  if (confirmed.status !== 200) {
    throw new Error(`two-factor/verify-totp answered ${confirmed.status}`);
  }
  return { secret, backupCodes, cookie: cookieHeader(confirmed) || cookie };
}

/** Signs up by password and gives the account `role`. */
export async function signUpAs(
  auth: TestAuth,
  db: Db,
  email: string,
  role: UserRole,
  over: Record<string, unknown> = {},
): Promise<{ userId: string; cookie: string }> {
  const response = await auth.handler(signUpRequest(email, over));
  if (response.status !== 200) {
    throw new Error(`sign-up answered ${response.status}`);
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error("no user after sign-up");
  if (role !== "user") {
    await db.update(users).set({ role }).where(eq(users.id, user.id));
  }
  return { userId: user.id, cookie: cookieHeader(response) };
}

/**
 * A password sign-in that answers the two-factor challenge with a code, as
 * the sign-in form does. Returns the session cookie.
 */
export async function signInWithTotp(
  auth: TestAuth,
  email: string,
  secret: string,
): Promise<string> {
  const first = await auth.handler(
    authPost("/sign-in/email", { email, password: PASSWORD }),
  );
  const body = (await first.json()) as { twoFactorRedirect?: boolean };
  if (!body.twoFactorRedirect) throw new Error("no two-factor challenge");
  const second = await auth.handler(
    authPost(
      "/two-factor/verify-totp",
      { code: await totpCode(auth, secret) },
      { cookie: cookieHeader(first) },
    ),
  );
  if (second.status !== 200) {
    throw new Error(`two-factor/verify-totp answered ${second.status}`);
  }
  return cookieHeader(second);
}

/** The viewer for a cookie, read as a page request would read it. */
export function viewerFor(
  db: ServerDb,
  cookie: string,
  now: () => Date,
): Promise<Viewer | null> {
  return getViewer(new Request(`${TEST_ORIGIN}/`, { headers: { cookie } }), {
    withDb: (fn) => fn(db),
    env: () => testAuthEnv(),
    now: async () => now(),
  });
}

/** The code an `IdentityError` carries, or null if `fn` doesn't throw one. */
export async function errorCode(
  fn: () => unknown | Promise<unknown>,
): Promise<string | null> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if ((error as Error).name === "IdentityError" && typeof code === "string") {
      return code;
    }
    throw error;
  }
  return null;
}
