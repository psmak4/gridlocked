import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Body,
  BottomBar,
  FormMessage,
  Screen,
  Title,
  linkClass,
} from "@/components/account-layout";
import { CAPTCHA_HEADER, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { checkEmailState } from "@/lib/check-email-state";
import { privateHeaders } from "@/lib/private-headers";

export const Route = createFileRoute("/auth-error")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  head: () => ({ meta: [{ title: "Sign-in problem · Gridlocked" }] }),
  headers: privateHeaders,
  component: AuthError,
});

const EXPIRED = ["invalid_token", "token_expired", "expired_token"];
const BANNED = ["banned", "banned_user"];

function AuthError() {
  const { error } = Route.useSearch();
  const router = useRouter();
  const code = (error ?? "").toLowerCase();
  const expired = EXPIRED.includes(code);
  const banned = BANNED.includes(code);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setMessage("Enter your email address.");
      return;
    }
    setWorking(true);
    const { error: failed } = await authClient.signIn.magicLink(
      {
        email: email.trim(),
        callbackURL: "/",
        newUserCallbackURL: "/welcome",
        errorCallbackURL: "/auth-error",
      },
      { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    );
    if (failed) {
      setWorking(false);
      setResetKey((k) => k + 1);
      setMessage(
        failed.status === 429
          ? "Too many tries. Wait a moment, then try again."
          : "We couldn't send it. Try again in a moment.",
      );
      return;
    }
    await router.navigate({
      to: "/check-email",
      state: checkEmailState(email.trim(), "link"),
    });
  }

  if (!expired) {
    return (
      <Screen>
        <Body className="pt-[64px]">
          <Title>
            {banned ? "This account can't sign in." : "We couldn't sign you in"}
          </Title>
          {banned ? null : (
            <p className="text-[16px] leading-[22px]">
              Something went wrong on the way in. Try again.
            </p>
          )}
          <a
            href="/sign-in"
            className={`${linkClass} inline-flex min-h-[44px] items-center text-[16px]`}
          >
            Back to sign in
          </a>
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body className="pt-[64px]">
          <Title>That link has expired</Title>
          <p className="text-[16px] leading-[22px]">
            Links work once, and only for a short while. Enter your email and
            we&apos;ll send a new one.
          </p>
          <TextField
            id="email"
            name="email"
            type="email"
            label="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Turnstile onToken={setToken} resetKey={resetKey} />
          <FormMessage>{message}</FormMessage>
          <a
            href="/sign-in"
            className={`${linkClass} inline-flex min-h-[44px] items-center text-[16px]`}
          >
            Back to sign in
          </a>
        </Body>
        <BottomBar>
          <Button
            type="submit"
            size="l"
            block
            disabled={working || token === null}
          >
            Email me a new link
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
