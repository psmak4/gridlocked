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
} from "@/components/account-layout";
import { Help } from "@/components/settings-parts";
import {
  USERNAME_MESSAGES,
  useUsernameCheck,
  type UsernameProblem,
} from "@/components/sign-up-fields";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { changeMyUsername, getUsernameSettings } from "@/server/account";

export const Route = createFileRoute("/settings/username")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Username · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getUsernameSettings(),
  component: Username,
});

const PROBLEMS: readonly string[] = ["format", "reserved", "held", "taken"];

/**
 * Changing the username (DM 6.3): once every 30 days, with the next date
 * shown; the old name stays held for 90. Moving capitals is always allowed.
 */
function Username() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const usernameCheck = useUsernameCheck();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<UsernameProblem | null>(null);
  const [message, setMessage] = useState<string>();
  const [changed, setChanged] = useState<string>();
  const [working, setWorking] = useState(false);
  const shown = problem ?? usernameCheck.problem;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    setChanged(undefined);
    setProblem(null);
    const wanted = name.trim();
    if (wanted === "") {
      setProblem("format");
      return;
    }
    setWorking(true);
    try {
      const result = await changeMyUsername({ data: { username: wanted } });
      if (result.ok) {
        setChanged(result.username);
        setName("");
        usernameCheck.clear();
        await router.invalidate();
      } else if (result.error === "username_too_soon") {
        setMessage(
          "nextChange" in result && result.nextChange
            ? `You can change it again from ${result.nextChange}.`
            : "You can't change it again yet.",
        );
      } else if (result.error === "read_only") {
        setMessage("This session is read-only.");
      } else if (PROBLEMS.includes(result.error)) {
        setProblem(result.error as UsernameProblem);
      } else {
        setMessage("We couldn't change it. Try again.");
      }
    } catch {
      setMessage("We couldn't change it. Try again in a moment.");
    }
    setWorking(false);
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
          <Title>Username</Title>
          {changed ? <Notice>Your username is now {changed}.</Notice> : null}
          <p className="text-[16px] leading-[22px]">
            Your username is <strong>{state.username}</strong>.
          </p>
          {state.nextChange ? (
            <Help>
              You can change it again from {state.nextChange}. Changing only its
              capital letters works at any time.
            </Help>
          ) : (
            <Help>
              You can change it now. After that, the next change can be{" "}
              {state.changeDays} days later.
            </Help>
          )}
          <Help>
            Your old name stays reserved for {state.holdDays} days, so nobody
            else can take it straight away.
          </Help>
          <TextField
            id="new-username"
            name="username"
            label="New username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            onBlur={() => void usernameCheck.check(name.trim())}
            hint="3 to 20 letters, numbers, underscores or dots."
            error={shown ? USERNAME_MESSAGES[shown] : undefined}
          />
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button type="submit" size="l" block disabled={working}>
            Change username
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
