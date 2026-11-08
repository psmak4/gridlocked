import { z } from "zod";

/**
 * What Better Auth needs from the environment (HLD §9). Parsed lazily, on the
 * first auth use, never when the module loads: the build and the logged-out
 * pages run without any of these set.
 *
 * Local mode (`VITE_LOCAL_DB=1`, the PGlite build the e2e tests run) needs
 * neither the secret nor the URL: it makes up a secret for the run and takes
 * the site's address from each request.
 */
export type AuthEnv = {
  secret: string;
  /** The site's fixed public address; null in local mode. */
  baseUrl: string | null;
  /** When set, only these (lowercase) addresses may sign up. */
  signUpAllowlist: string[] | null;
  /** Discord sign-in; null unless both variables are set. */
  discord: { clientId: string; clientSecret: string } | null;
  /** Turnstile's secret key. Always set outside local mode; optional there. */
  turnstileSecret: string | null;
  local: boolean;
};

const secret = z.string().min(32, "must be at least 32 characters");

function fromList(value: string | undefined): string[] | null {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
  return items.length > 0 ? items : null;
}

/** Problems are named by variable, never by value: a secret must not reach a log. */
function fail(name: string, error: z.ZodError): never {
  throw new Error(
    `Invalid ${name}: ${error.issues.map((i) => i.message).join("; ")}`,
  );
}

/** Discord sign-in is on when both variables are set. */
export function discordFrom(env: Record<string, string | undefined>) {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function parseAuthEnv(env: Record<string, string | undefined>): AuthEnv {
  const local = env.VITE_LOCAL_DB === "1";
  const signUpAllowlist = fromList(env.SIGN_UP_ALLOWED_EMAILS);
  if (local) {
    const given = secret.safeParse(env.BETTER_AUTH_SECRET);
    return {
      secret: given.success
        ? given.data
        : `${crypto.randomUUID()}${crypto.randomUUID()}`,
      baseUrl: env.BETTER_AUTH_URL ? z.url().parse(env.BETTER_AUTH_URL) : null,
      signUpAllowlist,
      discord: discordFrom(env),
      turnstileSecret: env.TURNSTILE_SECRET_KEY?.trim() || null,
      local,
    };
  }
  const parsedSecret = secret.safeParse(env.BETTER_AUTH_SECRET);
  if (!parsedSecret.success) fail("BETTER_AUTH_SECRET", parsedSecret.error);
  const parsedUrl = z.url().safeParse(env.BETTER_AUTH_URL);
  if (!parsedUrl.success) fail("BETTER_AUTH_URL", parsedUrl.error);
  // Without it the bot check would be off in production, so it is required.
  const parsedTurnstile = z
    .string()
    .trim()
    .min(1, "must be set")
    .safeParse(env.TURNSTILE_SECRET_KEY);
  if (!parsedTurnstile.success) {
    fail("TURNSTILE_SECRET_KEY", parsedTurnstile.error);
  }
  return {
    secret: parsedSecret.data,
    baseUrl: parsedUrl.data,
    signUpAllowlist,
    discord: discordFrom(env),
    turnstileSecret: parsedTurnstile.data,
    local,
  };
}
