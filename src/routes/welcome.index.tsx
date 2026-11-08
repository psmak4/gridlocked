import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Body,
  BottomBar,
  FormMessage,
  Screen,
  Title,
} from "@/components/account-layout";
import {
  ConsentFields,
  UsernameField,
  USERNAME_MESSAGES,
  useUsernameCheck,
} from "@/components/sign-up-fields";
import { Button } from "@/components/ui/button";
import { authClient } from "@/identity/auth-client";
import { privateHeaders } from "@/lib/private-headers";
import { finishSignUp } from "@/server/account";

export const Route = createFileRoute("/welcome/")({
  head: () => ({ meta: [{ title: "Finish signing up · Gridlocked" }] }),
  headers: privateHeaders,
  component: FinishSigningUp,
});

/** "Finish signing up": after a first Discord or magic-link sign-in (decision 3). */
function FinishSigningUp() {
  const { account } = Route.useRouteContext();
  const router = useRouter();
  const hasName = account?.username != null;
  const [username, setUsername] = useState("");
  const [ageConfirmed, setAge] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [boxes, setBoxes] = useState({ age: false, terms: false });
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const names = useUsernameCheck();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    setBoxes({ age: !ageConfirmed, terms: !accepted });
    const problem = hasName ? null : await names.check(username);
    if (!hasName && username === "") setMessage("Choose a username.");
    if (
      !ageConfirmed ||
      !accepted ||
      problem ||
      (!hasName && username === "")
    ) {
      return;
    }

    setWorking(true);
    try {
      const result = await finishSignUp({
        data: {
          ...(hasName ? {} : { username }),
          ageConfirmed: true,
          accepted: true,
        },
      });
      if (!result.ok) {
        setWorking(false);
        if (result.error in USERNAME_MESSAGES) {
          await names.check(username);
        } else {
          setMessage("We couldn't finish. Try again in a moment.");
        }
        return;
      }
    } catch {
      setWorking(false);
      setMessage("We couldn't finish. Try again in a moment.");
      return;
    }
    await router.navigate({ to: "/welcome/favorites" });
  }

  return (
    <Screen>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body className="pt-[48px]">
          <Title>Finish signing up</Title>
          <p className="text-[16px] leading-[22px] text-ink-muted">
            You&apos;re signed in. Choose a username and agree to the rules to
            get started.
          </p>
          {hasName ? null : (
            <UsernameField
              value={username}
              onChange={(next) => {
                setUsername(next);
                names.clear();
              }}
              onCheck={() => void names.check(username)}
              problem={names.problem}
            />
          )}
          <ConsentFields
            ageConfirmed={ageConfirmed}
            accepted={accepted}
            onAge={(next) => {
              setAge(next);
              if (next) setBoxes((b) => ({ ...b, age: false }));
            }}
            onAccepted={(next) => {
              setAccepted(next);
              if (next) setBoxes((b) => ({ ...b, terms: false }));
            }}
            ageError={boxes.age}
            termsError={boxes.terms}
          />
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button type="submit" size="l" block disabled={working}>
            Finish signing up
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="l"
            block
            onClick={async () => {
              await authClient.signOut();
              window.location.assign("/");
            }}
          >
            Sign out
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
