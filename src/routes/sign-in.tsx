import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  BottomBar,
  FormMessage,
  Notice,
  Screen,
  ScreenHeader,
  Title,
  linkClass,
} from "@/components/account-layout";
import { DiscordButton } from "@/components/discord-button";
import { CAPTCHA_HEADER, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { checkEmailState } from "@/lib/check-email-state";
import { getSignInOptions } from "@/server/account";

type SignInSearch = { mode?: "link"; changed?: "1" };

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...(search.mode === "link" ? { mode: "link" as const } : {}),
    ...(search.changed === "1" ? { changed: "1" as const } : {}),
  }),
  head: () => ({ meta: [{ title: "Sign in · Gridlocked" }] }),
  loader: () => getSignInOptions(),
  component: SignIn,
});

/** What went wrong, plainly. A ban's reason is never shown here. */
function signInMessage(error: { status?: number; code?: string }): string {
  if (error.code === "BANNED_USER") return "This account can't sign in.";
  if (error.status === 429)
    return "Too many tries. Wait a moment, then try again.";
  return "That email and password don't match.";
}

function SignIn() {
  const { mode, changed } = Route.useSearch();
  const { discord } = Route.useLoaderData();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const linkMode = mode === "link";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setMessage("Enter your email address.");
      return;
    }
    if (!linkMode && password === "") {
      setMessage("Enter your password.");
      return;
    }
    setWorking(true);
    const headers = token ? { [CAPTCHA_HEADER]: token } : {};
    if (linkMode) {
      const { error } = await authClient.signIn.magicLink(
        {
          email: email.trim(),
          callbackURL: "/",
          newUserCallbackURL: "/welcome",
          errorCallbackURL: "/auth-error",
        },
        { headers },
      );
      if (error) {
        setWorking(false);
        setResetKey((k) => k + 1);
        setMessage(
          error.status === 429
            ? "Too many tries. Wait a moment, then try again."
            : "We couldn't send it. Try again in a moment.",
        );
        return;
      }
      await router.navigate({
        to: "/check-email",
        state: checkEmailState(email.trim(), "link"),
      });
      return;
    }

    const { data, error } = await authClient.signIn.email(
      { email: email.trim(), password },
      { headers },
    );
    if (
      error ||
      (data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect
    ) {
      setWorking(false);
      setResetKey((k) => k + 1);
      setMessage(
        error
          ? signInMessage(error)
          : "This account needs a two-step code, which isn't on this screen yet.",
      );
      return;
    }
    await router.navigate({ to: "/" });
  }

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href={linkMode ? "/sign-in" : "/sign-up"} />
      </ScreenHeader>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body>
          <Title>{linkMode ? "Email me a sign-in link" : "Sign in"}</Title>
          {changed && !linkMode ? (
            <Notice>Password changed. Sign in with the new one.</Notice>
          ) : null}
          {linkMode ? (
            <p className="text-[16px] leading-[22px] text-ink-muted">
              We&apos;ll email you a link that signs you in. If you&apos;re new,
              it starts your account.
            </p>
          ) : discord ? (
            <DiscordButton />
          ) : null}
          <TextField
            id="email"
            name="email"
            type="email"
            label="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {linkMode ? null : (
            <TextField
              id="password"
              name="password"
              type="password"
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          <Turnstile onToken={setToken} resetKey={resetKey} />
          <FormMessage>{message}</FormMessage>
          {linkMode ? null : (
            <div className="flex flex-col items-start">
              <a
                href="/reset-password"
                className={`${linkClass} inline-flex min-h-[44px] items-center text-[16px]`}
              >
                Forgot your password?
              </a>
              <a
                href="/sign-in?mode=link"
                className={`${linkClass} inline-flex min-h-[44px] items-center text-[16px]`}
              >
                Email me a sign-in link
              </a>
            </div>
          )}
          <p className="text-[16px]">
            New here?{" "}
            <a href="/sign-up" className={linkClass}>
              Sign up
            </a>
          </p>
        </Body>
        <BottomBar>
          <Button
            type="submit"
            size="l"
            block
            disabled={working || token === null}
          >
            {linkMode ? "Send link" : "Sign in"}
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
