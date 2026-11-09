import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Body,
  BottomBar,
  FormMessage,
  Screen,
  ScreenHeader,
  Title,
  linkClass,
} from "@/components/account-layout";
import { Help } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { confirmMyDeletion } from "@/server/account";

type ConfirmSearch = { token?: string };

export const Route = createFileRoute("/settings/delete_/confirm")({
  validateSearch: (search: Record<string, unknown>): ConfirmSearch => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Delete your account · Gridlocked" },
      // The address carries a key: keep it out of other sites' logs.
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  // Private whether signed in or not: the link is a key (ruling 51e).
  headers: privateHeaders,
  component: ConfirmDeletion,
});

/**
 * Where the deletion email's link lands. Opening it deletes nothing, since
 * mail scanners open links; the button does. No sign-in is needed: the
 * token is the proof.
 */
function ConfirmDeletion() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"ask" | "deleted" | "expired">(
    token ? "ask" : "expired",
  );
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();

  async function confirm() {
    if (working || !token) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await confirmMyDeletion({ data: { token } });
      if (result.ok) setState("deleted");
      else if (result.error === "invalid_link") setState("expired");
      else if (result.error === "read_only")
        setMessage("This session is read-only.");
      else if (result.error === "last_admin")
        setMessage(
          "You're the only admin. Make someone else an admin before you go.",
        );
      else if (result.error === "role_reserved")
        setMessage("This account can't be deleted here.");
      else setMessage("We couldn't do that. Try again.");
    } catch {
      setMessage("We couldn't do that. Try again in a moment.");
    }
    setWorking(false);
  }

  if (state === "deleted") {
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

  if (state === "expired") {
    return (
      <Screen>
        <ScreenHeader>{null}</ScreenHeader>
        <Body>
          <Title>That link has expired</Title>
          <Help>
            Deletion links work once, for an hour, and only the newest one
            works. Nothing was deleted.
          </Help>
          <p className="text-[16px]">
            <a href="/settings/delete" className={linkClass}>
              Ask for a new link
            </a>
          </p>
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader>{null}</ScreenHeader>
      <Body>
        <Title>Delete your account?</Title>
        <Help>
          This can&apos;t be undone. Your teams leave their leagues, your posts
          stay as “deleted user”, and everything personal is erased.
        </Help>
        <FormMessage>{message}</FormMessage>
      </Body>
      <BottomBar>
        <Button
          type="button"
          size="l"
          block
          disabled={working}
          onClick={confirm}
        >
          Delete my account
        </Button>
        <a
          href="/"
          className={`${linkClass} inline-flex min-h-[44px] items-center justify-center text-[16px]`}
        >
          Keep my account
        </a>
      </BottomBar>
    </Screen>
  );
}
