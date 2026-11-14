import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { safeNext } from "@/lib/auth-gate";
import { checkEmailState } from "@/lib/check-email-state";
import { getSignInOptions } from "@/server/account";

/** `next`: where to go back to after signing in (a page that asked first). */
type SignInSearch = { mode?: "link"; changed?: "1"; next?: string };

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const next = safeNext(search.next);
    return {
      ...(search.mode === "link" ? { mode: "link" as const } : {}),
      ...(search.changed === "1" ? { changed: "1" as const } : {}),
      ...(next ? { next } : {}),
    };
  },
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

/** The two-step code's refusals, plainly (ruling 53). */
function codeMessage(
  error: { status?: number; code?: string },
  kind: "totp" | "backup",
): string {
  switch (error.code) {
    case "INVALID_CODE":
      return "That code didn't work. Check the app and try again.";
    case "INVALID_BACKUP_CODE":
      return "That backup code didn't work. Each one works once.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Too many wrong codes. Wait a while, then sign in again.";
  }
  if (error.status === 429) {
    return "Too many tries. Wait a moment, then try again.";
  }
  return kind === "totp"
    ? "That code didn't work. Check the app and try again."
    : "That backup code didn't work. Each one works once.";
}

/** The challenge has run out: the password step starts again. */
const EXPIRED = new Set([
  "INVALID_TWO_FACTOR_COOKIE",
  "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
]);

/**
 * The second step of a password sign-in for an account with two-step sign-in
 * on (ruling 53): the authenticator's code, or a backup code instead. Better
 * Auth's challenge cookie, not a session, carries the sign-in between steps.
 */
function TwoStepSignIn({
  onDone,
  onExpired,
}: {
  onDone: () => Promise<void>;
  onExpired: (message: string) => void;
}) {
  const [kind, setKind] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The field takes focus as the step opens and on each switch, so the
  // keyboard carries straight on.
  useEffect(() => field.current?.focus(), [kind]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    const typed = code.trim();
    if (typed === "") {
      setMessage(
        kind === "totp"
          ? "Enter the code from the app."
          : "Enter a backup code.",
      );
      return;
    }
    setWorking(true);
    const { error } =
      kind === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: typed })
        : await authClient.twoFactor.verifyBackupCode({ code: typed });
    if (error) {
      setWorking(false);
      if (error.code && EXPIRED.has(error.code)) {
        onExpired("That took too long. Sign in again.");
        return;
      }
      setMessage(codeMessage(error, kind));
      field.current?.focus();
      return;
    }
    await onDone();
  }

  function toggle() {
    setKind((k) => (k === "totp" ? "backup" : "totp"));
    setCode("");
    setMessage(undefined);
  }

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
          <Title>Two-step sign-in</Title>
          <p className="text-[16px] leading-[22px] text-ink-muted">
            {kind === "totp"
              ? "Open your authenticator app and enter the 6-digit code for Gridlocked."
              : "Enter one of the backup codes you kept. Each one works once."}
          </p>
          <TextField
            ref={field}
            key={kind}
            id="sign-in-code"
            name="code"
            label={
              kind === "totp"
                ? "Code from your authenticator app"
                : "Backup code"
            }
            inputMode={kind === "totp" ? "numeric" : "text"}
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <FormMessage>{message}</FormMessage>
          <div className="flex flex-col items-start">
            <button
              type="button"
              onClick={toggle}
              className={`${linkClass} inline-flex min-h-[44px] cursor-pointer items-center border-0 bg-transparent p-0 text-[16px]`}
            >
              {kind === "totp"
                ? "Use a backup code"
                : "Use the code from your app"}
            </button>
          </div>
        </Body>
        <BottomBar>
          <Button type="submit" size="l" block disabled={working}>
            Sign in
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}

function SignIn() {
  const { mode, changed, next } = Route.useSearch();
  const back = next ?? "/";
  const { discord } = Route.useLoaderData();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const [twoStep, setTwoStep] = useState(false);
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
          callbackURL: back,
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
    if (error) {
      setWorking(false);
      setResetKey((k) => k + 1);
      setMessage(signInMessage(error));
      return;
    }
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setWorking(false);
      setTwoStep(true);
      return;
    }
    await router.navigate({ href: back });
  }

  if (twoStep) {
    return (
      <TwoStepSignIn
        // Where the password sign-in would have gone.
        onDone={() => router.navigate({ href: back })}
        onExpired={(text) => {
          setTwoStep(false);
          setPassword("");
          setResetKey((k) => k + 1);
          setMessage(text);
        }}
      />
    );
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
            <DiscordButton next={back} />
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
                href={`/sign-in?mode=link${next ? `&next=${encodeURIComponent(next)}` : ""}`}
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
