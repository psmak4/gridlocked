import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  FormMessage,
  Notice,
  Screen,
  ScreenHeader,
  Title,
  linkClass,
} from "@/components/account-layout";
import { Help, SettingsGroup } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { getSecurity, unlockStaffTools } from "@/server/account";

export const Route = createFileRoute("/settings/security")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Password and security · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getSecurity(),
  component: Security,
});

const READ_ONLY = "IMPERSONATION_READ_ONLY";

/**
 * Password and security: the password change, and for staff the
 * authenticator set-up and this session's unlock (DM 6.4). Staff tools send
 * here when two-step sign-in is off, or on but not yet entered this session.
 */
function Security() {
  const state = Route.useLoaderData();
  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/settings">Settings</BackLink>
      </ScreenHeader>
      <Body className="gap-space-4 pt-space-1">
        <Title>Password and security</Title>
        <PasswordChange hasPassword={state.hasPassword} />
        {state.staff ? (
          <TwoStep
            hasPassword={state.hasPassword}
            enabled={state.twoFactorEnabled}
            unlocked={state.staffUnlocked}
          />
        ) : null}
      </Body>
    </Screen>
  );
}

function PasswordChange({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [done, setDone] = useState(false);

  if (!hasPassword) {
    return (
      <SettingsGroup id="password-heading" title="Password">
        <Help>You sign in without a password.</Help>
        <p className="text-[16px]">
          <a href="/reset-password" className={linkClass}>
            Set a password
          </a>{" "}
          with a link we email you.
        </p>
      </SettingsGroup>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    setDone(false);
    if (current === "") return setMessage("Enter your current password.");
    if (next.length < 10) return setMessage("Use at least 10 characters.");
    setWorking(true);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setWorking(false);
    if (error) {
      setMessage(
        error.code === READ_ONLY
          ? "This session is read-only."
          : error.code === "INVALID_PASSWORD"
            ? "That isn't your current password."
            : error.code === "PASSWORD_TOO_SHORT"
              ? "Use at least 10 characters."
              : "We couldn't change it. Try again in a moment.",
      );
      return;
    }
    setCurrent("");
    setNext("");
    setDone(true);
  }

  return (
    <SettingsGroup id="password-heading" title="Password">
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-[14px]"
      >
        <TextField
          id="current-password"
          name="current-password"
          type="password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <TextField
          id="new-password"
          name="new-password"
          type="password"
          label="New password"
          autoComplete="new-password"
          hint="At least 10 characters. You stay signed in here; other devices are signed out."
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        {done ? <Notice>Password changed.</Notice> : null}
        <FormMessage>{message}</FormMessage>
        <Button type="submit" variant="secondary" disabled={working}>
          Change password
        </Button>
      </form>
    </SettingsGroup>
  );
}

/** The base32 key in an `otpauth://` link, in fours for reading out. */
function setupKeyOf(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

function TwoStep({
  hasPassword,
  enabled,
  unlocked,
}: {
  hasPassword: boolean;
  enabled: boolean;
  unlocked: boolean;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ uri: string; codes: string[] }>();
  const [codes, setCodes] = useState<string[]>();
  const [code, setCode] = useState("");
  const [unlockCode, setUnlockCode] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();

  async function start(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    if (hasPassword && password === "") {
      return setMessage("Enter your password.");
    }
    setWorking(true);
    const { data, error } = await authClient.twoFactor.enable(
      hasPassword ? { password } : {},
    );
    setWorking(false);
    if (error || !data || !("totpURI" in data)) {
      setMessage(
        error?.code === "INVALID_PASSWORD"
          ? "That isn't your password."
          : error?.code === READ_ONLY
            ? "This session is read-only."
            : "We couldn't start that. Try again in a moment.",
      );
      return;
    }
    setPassword("");
    setSetup({ uri: data.totpURI, codes: data.backupCodes });
  }

  async function turnOn(event: FormEvent) {
    event.preventDefault();
    if (working || !setup) return;
    setMessage(undefined);
    setWorking(true);
    const { error } = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
    });
    setWorking(false);
    if (error) {
      setMessage("That code didn't work. Check the time on your phone.");
      return;
    }
    setCodes(setup.codes);
    setSetup(undefined);
    setCode("");
    await router.invalidate();
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    if (unlockCode.trim() === "") return setMessage("Enter a code.");
    setWorking(true);
    try {
      const result = await unlockStaffTools({ data: { code: unlockCode } });
      if (result.ok) {
        setUnlockCode("");
        await router.invalidate();
      } else {
        setMessage(
          result.error === "invalid_code"
            ? "That code didn't work. Check the time on your phone, or use a backup code."
            : result.error === "rate_limited"
              ? "Too many tries. Wait 15 minutes, then try again."
              : result.error === "read_only"
                ? "This session is read-only."
                : "We couldn't unlock staff tools.",
        );
      }
    } catch {
      setMessage("We couldn't unlock staff tools. Try again in a moment.");
    }
    setWorking(false);
  }

  return (
    <SettingsGroup id="two-step-heading" title="Two-step sign-in">
      {!enabled && !setup && !codes ? (
        <form
          method="post"
          noValidate
          onSubmit={start}
          className="flex flex-col gap-[14px]"
        >
          <Help>
            Staff tools need two-step sign-in. Set up an authenticator app, then
            enter a code from it once each time you sign in.
          </Help>
          {hasPassword ? (
            <TextField
              id="two-step-password"
              name="password"
              type="password"
              label="Your password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : null}
          <FormMessage>{message}</FormMessage>
          <Button type="submit" variant="secondary" disabled={working}>
            Set up an authenticator app
          </Button>
        </form>
      ) : null}

      {setup ? (
        <form
          method="post"
          noValidate
          onSubmit={turnOn}
          className="flex flex-col gap-[14px]"
        >
          <Help>Add this key to your authenticator app:</Help>
          <p
            data-testid="setup-key"
            className="rounded-radius-m bg-surface-raised px-space-3 py-space-3 font-numeric text-[18px] font-bold tracking-[0.08em] break-all"
          >
            {setupKeyOf(setup.uri)}
          </p>
          <p className="text-[16px]">
            On this phone?{" "}
            <a href={setup.uri} className={linkClass}>
              Open it in an authenticator app
            </a>
          </p>
          <TextField
            id="two-step-code"
            name="code"
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <FormMessage>{message}</FormMessage>
          <Button type="submit" variant="secondary" disabled={working}>
            Turn on
          </Button>
        </form>
      ) : null}

      {enabled || codes ? (
        <div className="flex flex-col gap-[14px]">
          <Notice>Two-step sign-in is on.</Notice>
          {codes ? (
            <div className="flex flex-col gap-space-2">
              <h3 className="text-[16px] font-bold">Your backup codes</h3>
              <Help>
                If you lose your phone, a backup code gets you in. Each one
                works once. You won&apos;t see them again.
              </Help>
              <ul
                data-testid="backup-codes"
                className="m-0 grid list-none grid-cols-2 gap-space-2 rounded-radius-m bg-surface-raised p-space-3 font-numeric text-[16px] font-bold"
              >
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {unlocked ? (
            <p className="text-[16px] font-semibold">
              Staff tools are unlocked for this session.
            </p>
          ) : (
            <form
              method="post"
              noValidate
              onSubmit={unlock}
              className="flex flex-col gap-[14px]"
            >
              <TextField
                id="unlock-code"
                name="code"
                label="Code from your app, or a backup code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                value={unlockCode}
                onChange={(e) => setUnlockCode(e.target.value)}
              />
              <FormMessage>{message}</FormMessage>
              <Button type="submit" variant="secondary" disabled={working}>
                Unlock staff tools
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </SettingsGroup>
  );
}
