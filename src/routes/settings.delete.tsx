import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
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
import { Help } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { andList } from "@/lib/settings-words";
import { getDeleteAccount, requestMyDeletion } from "@/server/account";

export const Route = createFileRoute("/settings/delete")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Delete your account · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getDeleteAccount(),
  component: DeleteAccount,
});

const REFUSALS: Record<string, string> = {
  wrong_username: "That isn't your username.",
  sign_in_again:
    "Your email address isn't confirmed, so sign in again and then delete within 10 minutes.",
  last_admin:
    "You're the only admin. Make someone else an admin before you go.",
  read_only: "This session is read-only.",
};

/**
 * Delete account (wave 4): what happens, a download first, the username
 * typed out, and an emailed link to finish (DM 6.7). Without a confirmed
 * address a sign-in in the last 10 minutes is the confirmation instead.
 */
function DeleteAccount() {
  const state = Route.useLoaderData();
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [sent, setSent] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const matches =
    typed.trim() !== "" &&
    typed.trim().toLowerCase() === state.username.toLowerCase();

  const points = [
    {
      title: "Your posts stay, without your name",
      text: "They show as “deleted user” so threads still make sense. Delete any posts you don’t want kept before you go.",
    },
    {
      title: "Your teams stop playing",
      text:
        state.teams.length > 0
          ? `${andList(state.teams)} ${state.teams.length > 1 ? "leave" : "leaves"} every league. Past standings keep ${state.teams.length > 1 ? "them" : "it"} as “Deleted team”.`
          : "Any team you have leaves every league. Past standings keep it as “Deleted team”.",
    },
    {
      title: "Leagues you run carry on",
      text:
        state.leagues.length > 0
          ? `${andList(state.leagues)} ${state.leagues.length > 1 ? "stay" : "stays"} open. A moderator can hand ${state.leagues.length > 1 ? "them" : "it"} to another member.`
          : "Any league you run stays open. A moderator can hand it to another member.",
    },
    {
      title: "Everything personal is erased",
      text: "Your email, sign-ins, profile and notifications are removed.",
    },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !matches) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await requestMyDeletion({
        data: { typedUsername: typed },
      });
      if (!result.ok) {
        setMessage(REFUSALS[result.error] ?? "We couldn't do that. Try again.");
      } else if (result.confirm === "email") {
        setSent(true);
      } else {
        // No confirmed address, and a fresh sign-in: it's done already.
        setDeleted(true);
      }
    } catch {
      setMessage("We couldn't do that. Try again in a moment.");
    }
    setWorking(false);
  }

  if (deleted) {
    return (
      <Screen>
        <ScreenHeader>{null}</ScreenHeader>
        <Body>
          <Title>Your account is deleted</Title>
          <Help>
            Everything personal is gone, and your posts stay as “deleted user”.
            You&apos;re welcome back any time.
          </Help>
          <p className="text-[16px]">
            <a href="/" className={linkClass}>
              Go to the home page
            </a>
          </p>
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/settings">Settings</BackLink>
      </ScreenHeader>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body>
          <Title>Delete your account</Title>
          <p className="text-[16px] leading-[24px]">
            This can&apos;t be undone. Here&apos;s what happens:
          </p>
          <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
            {points.map((point) => (
              <li
                key={point.title}
                className="flex flex-col gap-[2px] rounded-radius-m bg-surface-raised px-[14px] py-space-3"
              >
                <span className="text-[16px] leading-[20px] font-bold">
                  {point.title}
                </span>
                <span className="text-[14px] leading-[20px] text-ink-muted">
                  {point.text}
                </span>
              </li>
            ))}
          </ul>
          <a
            href="/settings/data"
            className="flex min-h-[48px] items-center justify-between rounded-radius-m border border-line px-[14px] text-[16px] font-bold text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Download my data first
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 5l7 7-7 7" />
            </svg>
          </a>
          <TextField
            id="confirm-username"
            name="confirm-username"
            label="Type your username to confirm"
            placeholder={state.username}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setSent(false);
            }}
          />
          {sent ? (
            <Notice>
              Check your email. The link to finish works for an hour.
            </Notice>
          ) : null}
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button type="submit" size="l" block disabled={!matches || working}>
            Delete my account
          </Button>
          <span className="text-center text-[14px] text-ink-muted">
            {state.emailVerified
              ? "We'll email you a final link to confirm."
              : "Your email isn't confirmed, so this deletes your account straight away."}
          </span>
        </BottomBar>
      </form>
    </Screen>
  );
}
