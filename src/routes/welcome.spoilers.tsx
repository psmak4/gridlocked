import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  BottomBar,
  FormMessage,
  Screen,
  ScreenHeader,
  StepLabel,
  Title,
} from "@/components/account-layout";
import { Button } from "@/components/ui/button";
import { onboardingGuard } from "@/lib/onboarding-guard";
import { privateHeaders } from "@/lib/private-headers";
import { getOnboarding, saveSpoilers } from "@/server/account";

export const Route = createFileRoute("/welcome/spoilers")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  beforeLoad: ({ context, search }) =>
    onboardingGuard({ account: context.account, search }),
  head: () => ({ meta: [{ title: "Do you watch live? · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getOnboarding(),
  component: Spoilers,
});

const OPTIONS = [
  {
    hide: true,
    title: "Hide results until I've watched",
    text: "Results, scores, standings and thread titles stay hidden until you mark a session as watched, or for 7 days.",
  },
  {
    hide: false,
    title: "Show me everything",
    text: "Best if you always watch live. You can turn protection on later.",
  },
] as const;

/** Step 2 of 2. "Hide results" is preselected, and Finish saves the choice. */
function Spoilers() {
  const saved = Route.useLoaderData();
  const router = useRouter();
  const [hide, setHide] = useState(true);
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function finish() {
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await saveSpoilers({
        data: { expectedVersion: saved.version, spoilerProtection: hide },
      });
      if (!result.ok) {
        setWorking(false);
        setMessage(
          result.error === "version_conflict"
            ? "Your profile changed somewhere else. Reload this page, then try again."
            : "We couldn't save that. Try again.",
        );
        return;
      }
    } catch {
      setWorking(false);
      setMessage("We couldn't save that. Try again in a moment.");
      return;
    }
    await router.navigate({ to: "/" });
  }

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/welcome/favorites" />
        <StepLabel>STEP 2 OF 2</StepLabel>
      </ScreenHeader>
      <Body>
        <div className="flex flex-col gap-[6px]">
          <Title>Do you watch live?</Title>
          <p className="text-[16px] leading-[22px] text-ink-muted">
            If you sometimes watch later, we can keep results out of your way.
          </p>
        </div>

        <fieldset className="m-0 flex flex-col gap-space-2 border-0 p-0">
          <legend className="sr-only">Spoiler protection</legend>
          {OPTIONS.map((option) => (
            <label
              key={option.title}
              className="flex cursor-pointer flex-col items-start gap-[4px] rounded-radius-m border-2 border-transparent bg-surface-raised p-[14px] has-checked:border-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring"
            >
              <input
                type="radio"
                name="spoiler-protection"
                className="sr-only"
                checked={hide === option.hide}
                onChange={() => setHide(option.hide)}
              />
              <span className="font-display text-[18px] leading-[22px] tracking-[0.02em] uppercase">
                {option.title}
              </span>
              <span className="text-[14px] leading-[20px] text-ink-muted">
                {option.text}
              </span>
            </label>
          ))}
        </fieldset>

        <p className="text-[12px] font-bold tracking-[0.12em] text-ink-muted">
          WHAT HIDDEN LOOKS LIKE
        </p>
        <div className="flex flex-col gap-[4px] rounded-radius-m bg-veil p-[14px]">
          <span className="text-[16px] font-bold">Race: results are in</span>
          <span className="text-[14px] text-ink-muted">
            You haven&apos;t marked the race as watched.
          </span>
        </div>
        <FormMessage>{message}</FormMessage>
      </Body>
      <BottomBar>
        <Button
          type="button"
          size="l"
          block
          disabled={working}
          onClick={finish}
        >
          Finish
        </Button>
      </BottomBar>
    </Screen>
  );
}
