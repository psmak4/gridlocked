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
import {
  ConsentFields,
  UsernameField,
  useUsernameCheck,
} from "@/components/sign-up-fields";
import { CAPTCHA_HEADER, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/identity/auth-client";
import { checkEmailState } from "@/lib/check-email-state";

export const Route = createFileRoute("/sign-up/email")({
  head: () => ({ meta: [{ title: "Create your account · Gridlocked" }] }),
  component: SignUpWithEmail,
});

const MIN_PASSWORD = 10;

function SignUpWithEmail() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [ageConfirmed, setAge] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [boxes, setBoxes] = useState({ age: false, terms: false });
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const names = useUsernameCheck();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    const emailBad = !/^\S+@\S+\.\S+$/.test(email.trim());
    const passwordBad = password.length < MIN_PASSWORD;
    setEmailError(emailBad ? "Enter your email address." : undefined);
    setPasswordError(
      passwordBad ? `Use at least ${MIN_PASSWORD} characters.` : undefined,
    );
    setBoxes({ age: !ageConfirmed, terms: !accepted });
    const problem = await names.check(username);
    if (username === "") {
      setMessage("Choose a username.");
    }
    if (
      emailBad ||
      passwordBad ||
      !ageConfirmed ||
      !accepted ||
      problem ||
      username === ""
    ) {
      return;
    }

    setWorking(true);
    const { error } = await authClient.signUp.email(
      {
        email: email.trim(),
        password,
        name: username,
        username,
        ageConfirmed: true,
        accepted: true,
        callbackURL: "/welcome/favorites",
      } as Parameters<typeof authClient.signUp.email>[0],
      { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    );
    if (error) {
      setWorking(false);
      // A token works once.
      setResetKey((k) => k + 1);
      setMessage(signUpMessage(error));
      return;
    }
    await router.navigate({
      to: "/check-email",
      state: checkEmailState(email.trim(), "verify"),
    });
  }

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/sign-up" />
      </ScreenHeader>
      <form
        method="post"
        noValidate
        onSubmit={submit}
        className="flex flex-1 flex-col"
      >
        <Body>
          <Title>Create your account</Title>
          <TextField
            id="email"
            name="email"
            type="email"
            label="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
          />
          <TextField
            id="password"
            name="password"
            type="password"
            label="Password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={passwordError}
          />
          <UsernameField
            value={username}
            onChange={(next) => {
              setUsername(next);
              names.clear();
            }}
            onCheck={() => void names.check(username)}
            problem={names.problem}
          />
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
          <Turnstile onToken={setToken} resetKey={resetKey} />
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button
            type="submit"
            size="l"
            block
            disabled={working || token === null}
          >
            Create account
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}

/** What went wrong, in words that give nothing away about other accounts. */
function signUpMessage(error: { status?: number; message?: string }): string {
  if (error.status === 429)
    return "Too many tries. Wait a moment, then try again.";
  if (error.status === 403) return "Sign-up isn't open for that address.";
  return "We couldn't create the account. Check what you entered and try again.";
}
