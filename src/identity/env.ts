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

const secret = z
  .string("must be set")
  .min(32, "must be at least 32 characters");

function fromList(value: string | undefined): string[] | null {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
  return items.length > 0 ? items : null;
}

/**
 * A setting that is missing or malformed. It names the variable and what is
 * wrong with it, never the value: a secret must not reach a log or Sentry.
 */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    problem: string,
  ) {
    super(`Invalid ${variable}: ${problem}`);
    this.name = "ConfigError";
  }
}

/** Our own messages only: Zod's issues can quote the input. */
function fail(name: string, error: z.ZodError): never {
  throw new ConfigError(name, error.issues.map((i) => i.message).join("; "));
}

const url = z.url("must be a URL");

/** Discord sign-in is on when both variables are set. */
export function discordFrom(env: Record<string, string | undefined>) {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function parseUrl(value: string | undefined): string {
  const parsed = url.safeParse(value);
  if (!parsed.success) fail("BETTER_AUTH_URL", parsed.error);
  return parsed.data;
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
      baseUrl: env.BETTER_AUTH_URL ? parseUrl(env.BETTER_AUTH_URL) : null,
      signUpAllowlist,
      discord: discordFrom(env),
      turnstileSecret: env.TURNSTILE_SECRET_KEY?.trim() || null,
      local,
    };
  }
  const parsedSecret = secret.safeParse(env.BETTER_AUTH_SECRET);
  if (!parsedSecret.success) fail("BETTER_AUTH_SECRET", parsedSecret.error);
  const baseUrl = parseUrl(env.BETTER_AUTH_URL);
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
    baseUrl,
    signUpAllowlist,
    discord: discordFrom(env),
    turnstileSecret: parsedTurnstile.data,
    local,
  };
}
