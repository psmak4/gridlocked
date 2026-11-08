import { createAuth } from "@/identity/auth";
import type { AuthEnv } from "@/identity/env";
import type { Db } from "@/db/types";
import type { EmailSender } from "@/identity/email/sender";

/** A fake secret for tests only. Never a real one. */
export const TEST_AUTH_SECRET = "test-only-fake-secret-0123456789ab";

export const TEST_ORIGIN = "http://localhost:3000";

/** A fixed instant for the code that takes `now` from its caller. */
export const TEST_NOW = new Date("2026-11-07T12:00:00Z");

export function testAuthEnv(over: Partial<AuthEnv> = {}): AuthEnv {
  return {
    secret: TEST_AUTH_SECRET,
    baseUrl: TEST_ORIGIN,
    signUpAllowlist: null,
    discord: null,
    turnstileSecret: null,
    local: false,
    ...over,
  };
}

export function testAuth(
  db: Db,
  over: {
    env?: Partial<AuthEnv>;
    now?: () => Date;
    sender?: EmailSender | null;
  } = {},
) {
  return createAuth(db, {
    env: testAuthEnv(over.env),
    now: over.now ?? (() => TEST_NOW),
    sender: over.sender ?? null,
  });
}

export type TestAuth = ReturnType<typeof testAuth>;

/** A JSON POST to an auth path, as a browser on the site would send it. */
export function authPost(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${TEST_ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export const PASSWORD = "correct horse battery";

export function signUpRequest(
  email: string,
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return authPost(
    "/sign-up/email",
    { email, password: PASSWORD, name: "Test Person", ...over },
    headers,
  );
}

/** The `name=value` pairs of a response's Set-Cookie headers, as a Cookie header. */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export type SentEmail = { to: string; subject: string; text: string };

/** An `EmailSender` that keeps what it was given, so a test can follow a link. */
export function recordingSender() {
  const sent: SentEmail[] = [];
  const sender: EmailSender = {
    async send(message) {
      sent.push({
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { id: `fake-${sent.length}` };
    },
  };
  return {
    sender,
    sent,
    /** The most recent email to `to` whose subject contains `subject`. */
    last(to: string, subject: string): SentEmail | undefined {
      return [...sent]
        .reverse()
        .find((m) => m.to === to && m.subject.includes(subject));
    },
  };
}

/** The one link in an email's text. */
export function linkIn(email: SentEmail | undefined): string {
  const link = email?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("no link in the email");
  return link;
}

/** A GET to a link from an email, as a browser that clicked it would send it. */
export function clickLink(link: string, cookie?: string): Request {
  return new Request(link, cookie ? { headers: { cookie } } : undefined);
}
