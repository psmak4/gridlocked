import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  FormMessage,
  Screen,
  ScreenHeader,
  Title,
  linkClass,
} from "@/components/account-layout";
import { Help, Panel } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { authClient } from "@/identity/auth-client";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { getSignInMethods, removeSignInMethod } from "@/server/account";

export const Route = createFileRoute("/settings/sign-in")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Sign-in methods · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getSignInMethods(),
  component: SignInMethods,
});

const REFUSALS: Record<string, string> = {
  last_method: "That's your only way to sign in, so it can't be removed.",
  read_only: "This session is read-only.",
  not_linked: "That isn't linked any more. Reload this page.",
};

/**
 * The ways in (ruling 51d): each linked method, with Remove unless it is the
 * last way in (the server refuses that too). A confirmed address is a way in
 * of its own, by an emailed link (Ruling 58). Link Discord only when Discord
 * is set up on this site.
 */
function SignInMethods() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const { hasPassword } = state;
  const hasDiscord = state.methods.some((m) => m.providerId === "discord");

  async function remove(providerId: string) {
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await removeSignInMethod({ data: { providerId } });
      if (result.ok) await router.invalidate();
      else setMessage(REFUSALS[result.error] ?? "We couldn't remove it.");
    } catch {
      setMessage("We couldn't remove it. Try again in a moment.");
    }
    setWorking(false);
  }

  async function linkDiscord() {
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    const { error } = await authClient.linkSocial({
      provider: "discord",
      callbackURL: "/settings/sign-in",
      errorCallbackURL: "/auth-error",
    });
    // On success the browser leaves for Discord.
    if (error) {
      setWorking(false);
      setMessage(
        error.code === "IMPERSONATION_READ_ONLY"
          ? REFUSALS.read_only
          : "We couldn't reach Discord. Try again in a moment.",
      );
    }
  }

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/settings">Settings</BackLink>
      </ScreenHeader>
      <Body>
        <Title>Sign-in methods</Title>
        <Panel>
          <ul className="m-0 flex list-none flex-col p-0">
            {state.methods.map((method) => (
              <li
                key={method.providerId}
                className="flex min-h-[64px] items-center justify-between gap-space-3 border-b border-line px-[14px] py-space-2 last:border-b-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-[16px] font-bold">{method.label}</span>
                  <span className="text-[14px] break-all text-ink-muted">
                    {method.providerId === "credential"
                      ? state.email
                      : !method.removable
                        ? null
                        : "Linked"}
                  </span>
                  {!method.removable ? (
                    <span className="text-[14px] text-ink-muted">
                      Your only way to sign in, so it can&apos;t be removed.
                    </span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={!method.removable || working}
                  onClick={() => remove(method.providerId)}
                  aria-label={`Remove ${method.label}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
        <FormMessage>{message}</FormMessage>
        <Help>
          A sign-in link can also be emailed to {state.email} at any time.
        </Help>
        {state.discordAvailable && !hasDiscord ? (
          <Button
            type="button"
            size="l"
            block
            variant="secondary"
            disabled={working}
            onClick={linkDiscord}
          >
            Link Discord
          </Button>
        ) : null}
        {hasPassword ? null : (
          <p className="text-[16px]">
            No password yet?{" "}
            <a href="/reset-password" className={linkClass}>
              Set a password
            </a>{" "}
            by email.
          </p>
        )}
      </Body>
    </Screen>
  );
}
