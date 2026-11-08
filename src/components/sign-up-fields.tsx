import { useRef, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { linkClass } from "@/components/account-layout";
import { checkUsername, type UsernameCheck } from "@/server/account";

export type UsernameProblem = NonNullable<UsernameCheck["problem"]>;

/** What each refusal says. The name is never echoed back. */
export const USERNAME_MESSAGES: Record<UsernameProblem, string> = {
  format: "Use 3 to 20 letters, numbers, underscores or dots.",
  reserved: "That name is reserved. Try another.",
  held: "That name was used recently and is on hold. Try another.",
  taken: "That name is taken.",
};

export const AGE_ERROR = "Confirm you're 16 or older.";
export const TERMS_ERROR =
  "Accept the terms, privacy policy and community rules to continue.";

/**
 * Asks the server why a username can't be used, with no reload. Answers that
 * arrive late (the person kept typing) are dropped.
 */
export function useUsernameCheck() {
  const [problem, setProblem] = useState<UsernameProblem | null>(null);
  const latest = useRef(0);

  async function check(name: string): Promise<UsernameProblem | null> {
    const ask = ++latest.current;
    if (name === "") {
      setProblem(null);
      return null;
    }
    const answer = await checkUsername({ data: { username: name } });
    if (ask !== latest.current) return answer.problem;
    setProblem(answer.problem);
    return answer.problem;
  }

  return {
    problem,
    check,
    clear: () => {
      latest.current++;
      setProblem(null);
    },
  };
}

const newTab = {
  target: "_blank",
  rel: "noopener",
} as const;

function LegalLink({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <a href={`/legal/${kind}`} className={linkClass} {...newTab}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function UsernameField({
  value,
  onChange,
  onCheck,
  problem,
}: {
  value: string;
  onChange: (next: string) => void;
  onCheck: () => void;
  problem: UsernameProblem | null;
}) {
  return (
    <TextField
      id="username"
      name="username"
      label="Username"
      autoComplete="username"
      autoCapitalize="none"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCheck}
      hint="3 to 20 letters, numbers, underscores or dots. Shown on everything you post."
      error={problem ? USERNAME_MESSAGES[problem] : undefined}
    />
  );
}

/** The two boxes. Both must be checked, and the server asks again. */
export function ConsentFields({
  ageConfirmed,
  accepted,
  onAge,
  onAccepted,
  ageError,
  termsError,
}: {
  ageConfirmed: boolean;
  accepted: boolean;
  onAge: (next: boolean) => void;
  onAccepted: (next: boolean) => void;
  ageError: boolean;
  termsError: boolean;
}) {
  return (
    <div className="flex flex-col gap-space-1">
      <Checkbox
        id="age-confirmed"
        label="I'm 16 or older"
        checked={ageConfirmed}
        onCheckedChange={onAge}
        error={ageError ? AGE_ERROR : undefined}
      />
      <Checkbox
        id="accepted"
        label={
          <span>
            I agree to the <LegalLink kind="terms">Terms</LegalLink>,{" "}
            <LegalLink kind="privacy">Privacy Policy</LegalLink> and{" "}
            <LegalLink kind="community_rules">Community rules</LegalLink>
          </span>
        }
        checked={accepted}
        onCheckedChange={onAccepted}
        error={termsError ? TERMS_ERROR : undefined}
      />
    </div>
  );
}
