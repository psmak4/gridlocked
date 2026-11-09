import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Body,
  BottomBar,
  FormMessage,
  Screen,
  ScreenHeader,
  StepLabel,
  Title,
} from "@/components/account-layout";
import { FavoritesFields } from "@/components/favorites-fields";
import { Button } from "@/components/ui/button";
import { onboardingGuard } from "@/lib/onboarding-guard";
import { privateHeaders } from "@/lib/private-headers";
import { getOnboarding, saveFavorites } from "@/server/account";

export const Route = createFileRoute("/welcome/favorites")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  beforeLoad: ({ context, search }) =>
    onboardingGuard({ account: context.account, search }),
  head: () => ({ meta: [{ title: "Who do you support? · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getOnboarding(),
  component: Favorites,
});

/** Step 1 of 2. Skippable: nothing here is needed to play. */
function Favorites() {
  const saved = Route.useLoaderData();
  const router = useRouter();
  const [team, setTeam] = useState(saved.favoriteConstructorId ?? "");
  const [driver, setDriver] = useState(saved.favoriteDriverId ?? "");
  const [country, setCountry] = useState(saved.countryCode ?? "");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function next() {
    if (working) return;
    setMessage(undefined);
    const changed =
      team !== (saved.favoriteConstructorId ?? "") ||
      driver !== (saved.favoriteDriverId ?? "") ||
      country !== (saved.countryCode ?? "");
    if (changed) {
      setWorking(true);
      try {
        const result = await saveFavorites({
          data: {
            expectedVersion: saved.version,
            favoriteConstructorId: team || null,
            favoriteDriverId: driver || null,
            countryCode: country || null,
          },
        });
        if (!result.ok) {
          setWorking(false);
          setMessage(
            result.error === "version_conflict"
              ? "Your profile changed somewhere else. Reload this page to see the latest, then try again."
              : "We couldn't save that. Try again.",
          );
          return;
        }
      } catch {
        setWorking(false);
        setMessage("We couldn't save that. Try again in a moment.");
        return;
      }
    }
    await router.navigate({ to: "/welcome/spoilers" });
  }

  return (
    <Screen>
      <ScreenHeader>
        <StepLabel>STEP 1 OF 2</StepLabel>
        <a
          href="/welcome/spoilers"
          className="inline-flex min-h-[44px] items-center rounded-radius-m px-space-2 text-[16px] font-bold text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          Skip
        </a>
      </ScreenHeader>
      <Body>
        <div className="flex flex-col gap-[6px]">
          <Title>Who do you support?</Title>
          <p className="text-[16px] leading-[22px] text-ink-muted">
            Your favorites put you in a fans&apos; league for that team and
            driver. You can change them later.
          </p>
        </div>

        <FavoritesFields
          value={{ team, driver, country }}
          onChange={(next) => {
            setTeam(next.team);
            setDriver(next.driver);
            setCountry(next.country);
          }}
          choices={saved.choices}
          countries={saved.countries}
        />
        <FormMessage>{message}</FormMessage>
      </Body>
      <BottomBar>
        <Button type="button" size="l" block disabled={working} onClick={next}>
          Continue
        </Button>
      </BottomBar>
    </Screen>
  );
}
