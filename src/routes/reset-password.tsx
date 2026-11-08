import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  BottomBar,
  FormMessage,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";
import { CAPTCHA_HEADER, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { checkEmailState } from "@/lib/check-email-state";
import { privateHeaders } from "@/lib/private-headers";

type ResetSearch = { token?: string; error?: string };

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  head: () => ({ meta: [{ title: "Reset your password · Gridlocked" }] }),
  headers: privateHeaders,
  component: ResetPassword,
});

const MIN_PASSWORD = 10;

function ResetPassword() {
  const { token, error: linkError } = Route.useSearch();
  const router = useRouter();
  const [expired, setExpired] = useState(linkError !== undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const choosing = token !== undefined && !expired;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);

    if (choosing) {
      if (password.length < MIN_PASSWORD) {
        setMessage(`Use at least ${MIN_PASSWORD} characters.`);
        return;
      }
      setWorking(true);
      const { error } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (error) {
        setWorking(false);
        if (error.code === "INVALID_TOKEN" || error.status === 400) {
          setExpired(true);
          return;
        }
        setMessage("We couldn't save it. Try again in a moment.");
        return;
      }
      await router.navigate({ to: "/sign-in", search: { changed: "1" } });
      return;
    }

    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setMessage("Enter your email address.");
      return;
    }
    setWorking(true);
    const { error } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: "/reset-password",
      fetchOptions: { headers: captcha ? { [CAPTCHA_HEADER]: captcha } : {} },
    });
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
      state: checkEmailState(email.trim(), "reset"),
    });
  }

  const title = choosing
    ? "Choose a new password"
    : expired
      ? "That link has expired"
      : "Reset your password";

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/sign-in" />
      </ScreenHeader>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body>
          <Title>{title}</Title>
          {expired ? (
            <p className="text-[16px] leading-[22px] text-ink-muted">
              A reset link works once, and for an hour. Ask for a new one.
            </p>
          ) : choosing ? null : (
            <p className="text-[16px] leading-[22px] text-ink-muted">
              Enter your email and we&apos;ll send a link to choose a new
              password.
            </p>
          )}
          {choosing ? (
            <TextField
              id="new-password"
              name="new-password"
              type="password"
              label="New password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={`At least ${MIN_PASSWORD} characters.`}
            />
          ) : (
            <>
              <TextField
                id="email"
                name="email"
                type="email"
                label="Email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Turnstile onToken={setCaptcha} resetKey={resetKey} />
            </>
          )}
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button
            type="submit"
            size="l"
            block
            disabled={working || (!choosing && captcha === null)}
          >
            {choosing
              ? "Save password"
              : expired
                ? "Send a new reset link"
                : "Send reset link"}
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
