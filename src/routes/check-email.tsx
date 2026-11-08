import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Body,
  BottomBar,
  FormMessage,
  Notice,
  Screen,
  Title,
  linkClass,
} from "@/components/account-layout";
import { DiscordButton } from "@/components/discord-button";
import { CAPTCHA_HEADER, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { readCheckEmailState, type CheckKind } from "@/lib/check-email-state";
import { formatCountdown } from "@/lib/format-countdown";
import { privateHeaders } from "@/lib/private-headers";
import { getEmailBusy, getSignInOptions } from "@/server/account";

/** Better Auth lets one verification email go per 40 seconds. */
const RESEND_SECONDS = 40;

export const Route = createFileRoute("/check-email")({
  head: () => ({ meta: [{ title: "Check your email · Gridlocked" }] }),
  headers: privateHeaders,
  loader: async () => {
    const [{ busy }, { discord }] = await Promise.all([
      getEmailBusy(),
      getSignInOptions(),
    ]);
    return { busy, discord };
  },
  component: CheckYourEmail,
});

function CheckYourEmail() {
  const { busy, discord } = Route.useLoaderData();
  const router = useRouter();
  const [kind, setKind] = useState<CheckKind>("verify");
  const [email, setEmail] = useState<string>();
  const [wait, setWait] = useState(RESEND_SECONDS);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [message, setMessage] = useState<string>();
  const [sent, setSent] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [working, setWorking] = useState(false);

  // The address comes from history state, which the server never sees; read
  // after hydration so the first client render matches the server's.
  useEffect(() => {
    const { email: given, kind: why } = readCheckEmailState(
      router.state.location.state,
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmail(given);
    if (why) setKind(why);
  }, [router]);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const headers = () => (token ? { [CAPTCHA_HEADER]: token } : {});

  async function resend() {
    if (!email || working) return;
    setWorking(true);
    setMessage(undefined);
    const { error } =
      kind === "verify"
        ? await authClient.sendVerificationEmail({
            email,
            callbackURL: "/welcome/favorites",
            fetchOptions: { headers: headers() },
          })
        : kind === "link"
          ? await authClient.signIn.magicLink(
              {
                email,
                callbackURL: "/",
                newUserCallbackURL: "/welcome",
                errorCallbackURL: "/auth-error",
              },
              { headers: headers() },
            )
          : await authClient.requestPasswordReset({
              email,
              redirectTo: "/reset-password",
              fetchOptions: { headers: headers() },
            });
    setWorking(false);
    setResetKey((k) => k + 1);
    if (error) {
      setMessage(
        error.status === 429
          ? "That was too soon. Wait a moment, then try again."
          : "We couldn't send it. Try again in a moment.",
      );
      return;
    }
    setSent(true);
    setWait(RESEND_SECONDS);
  }

  async function changeAddress() {
    const next = newEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(next)) {
      setMessage("Enter your email address.");
      return;
    }
    setWorking(true);
    setMessage(undefined);
    const { error } = await authClient.changeEmail({
      newEmail: next,
      callbackURL: "/welcome/favorites",
      fetchOptions: { headers: headers() },
    });
    setWorking(false);
    setResetKey((k) => k + 1);
    if (error) {
      setMessage("We couldn't change it. Check the address and try again.");
      return;
    }
    setEmail(next);
    setChanging(false);
    setSent(true);
    setWait(RESEND_SECONDS);
  }

  const lead =
    kind === "reset"
      ? "If that address has an account, we sent a link to choose a new password."
      : kind === "link"
        ? "We sent a sign-in link"
        : "We sent a link";

  return (
    <Screen>
      <Body className="pt-[64px]">
        <Title>Check your email</Title>
        <p className="text-[16px] leading-[24px]">
          {kind === "reset" ? (
            lead
          ) : (
            <>
              {lead} to{" "}
              {email ? <strong>{email}</strong> : "your email address"}. Open it
              on this phone to{" "}
              {kind === "link" ? "sign in" : "finish signing up"}.
            </>
          )}
        </p>

        {busy && kind === "verify" ? (
          <div className="flex flex-col gap-[4px] rounded-radius-m bg-surface-raised px-[14px] py-[12px]">
            <span className="text-[16px] leading-[22px] font-bold">
              It might take a while today
            </span>
            <span className="text-[14px] leading-[20px] text-ink-muted">
              Lots of people are signing up, so emails are queued. Yours will
              arrive within a few hours.
              {discord ? " Signing in with Discord works straight away." : ""}
            </span>
          </div>
        ) : null}

        {sent ? <Notice>Sent. Check your inbox.</Notice> : null}
        <FormMessage>{message}</FormMessage>

        {email ? (
          <div className="flex flex-col gap-[10px]">
            <Button
              type="button"
              variant="secondary"
              size="l"
              block
              disabled={wait > 0 || working || token === null}
              onClick={resend}
            >
              {wait > 0
                ? `Send it again (in ${formatCountdown(wait)})`
                : "Send it again"}
            </Button>
            {discord && kind === "verify" ? (
              <DiscordButton variant="quiet" />
            ) : null}
            {kind === "verify" ? (
              changing ? (
                <div className="flex flex-col gap-space-2">
                  <TextField
                    id="new-email"
                    type="email"
                    label="Correct email address"
                    autoComplete="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="l"
                    block
                    disabled={working || token === null}
                    onClick={changeAddress}
                  >
                    Change address
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className={`${linkClass} inline-flex min-h-[44px] items-center self-center text-[16px]`}
                  onClick={() => setChanging(true)}
                >
                  Wrong address? Change it
                </button>
              )
            ) : (
              <a
                href={
                  kind === "link" ? "/sign-in?mode=link" : "/reset-password"
                }
                className={`${linkClass} inline-flex min-h-[44px] items-center self-center text-[16px]`}
              >
                Wrong address? Change it
              </a>
            )}
            <Turnstile onToken={setToken} resetKey={resetKey} />
          </div>
        ) : null}

        {kind === "verify" ? (
          <p className="text-[14px] leading-[20px] text-ink-muted">
            Until you confirm, you can look around and build a team, but you
            can&apos;t post or chat.
          </p>
        ) : null}
      </Body>
      {kind === "verify" ? (
        <BottomBar>
          <Button staticLink href="/welcome/favorites" size="l" block>
            Look around for now
          </Button>
        </BottomBar>
      ) : null}
    </Screen>
  );
}
