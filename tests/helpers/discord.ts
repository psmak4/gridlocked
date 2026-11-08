import type { Mock } from "vitest";
import { TEST_ORIGIN, authPost, cookieHeader } from "./auth";

export type DiscordUser = { id: string; email: string; verified: boolean };

/** Something with a Better Auth handler: the auth instance, or the site's route. */
export type AuthHandler = { handler(request: Request): Promise<Response> };

/**
 * A `fetch` that answers Discord's token and `@me` URLs and nothing else. Any
 * other URL throws, so a test notices a call it did not expect.
 */
export function discordFetch(user: DiscordUser): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === "https://discord.com/api/oauth2/token") {
      return Response.json({
        access_token: "fake-discord-access-token",
        token_type: "Bearer",
        expires_in: 604_800,
        scope: "identify email",
      });
    }
    // betterFetch percent-encodes the "@".
    if (url === "https://discord.com/api/users/%40me") {
      return Response.json({
        id: user.id,
        username: "fake_discord_user",
        global_name: "Fake Discord User",
        discriminator: "0",
        avatar: null,
        email: user.email,
        verified: user.verified,
      });
    }
    throw new Error("unexpected fetch in a Discord test " + url);
  };
}

/**
 * Drives `/sign-in/social` to the `/callback/discord` redirect in-process and
 * returns the callback's response. `fetchStub` is the test's stubbed global
 * `fetch`; this points it at a fake Discord for `user`. No Discord application
 * is involved.
 */
export async function signInWithDiscord(
  auth: AuthHandler,
  fetchStub: Mock<typeof fetch>,
  user: DiscordUser,
): Promise<Response> {
  fetchStub.mockImplementation(discordFetch(user));
  const start = await auth.handler(
    authPost("/sign-in/social", { provider: "discord", callbackURL: "/" }),
  );
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("no state in the authorization URL");
  return auth.handler(
    new Request(
      `${TEST_ORIGIN}/api/auth/callback/discord?code=fake-code&state=${state}`,
      { headers: { cookie: cookieHeader(start) } },
    ),
  );
}
