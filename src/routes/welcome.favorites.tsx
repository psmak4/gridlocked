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
  selectClass,
} from "@/components/account-layout";
import { Button } from "@/components/ui/button";
import { onboardingGuard } from "@/lib/onboarding-guard";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
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
  const { constructors, drivers } = saved.choices;

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

        {constructors.length > 0 ? (
          <fieldset className="m-0 flex flex-col gap-space-2 border-0 p-0">
            <legend className="pb-space-2 text-[14px] font-bold">
              Favorite team
            </legend>
            <div className="grid grid-cols-3 gap-space-2">
              {constructors.map((c) => {
                const picked = team === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => setTeam(picked ? "" : c.id)}
                    className={cn(
                      "flex min-h-[64px] cursor-pointer flex-col items-center justify-center gap-[6px] rounded-radius-m border-2 bg-surface-raised px-[2px] py-space-2 font-sans text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                      picked ? "border-ink" : "border-transparent",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="h-[6px] w-[28px] rounded-radius-pill"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="text-center text-[12px] leading-[14px] font-semibold">
                      {c.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {drivers.length > 0 ? (
          <div className="flex flex-col gap-[6px]">
            <label htmlFor="fav-driver" className="text-[14px] font-bold">
              Favorite driver
            </label>
            <select
              id="fav-driver"
              className={selectClass}
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
            >
              <option value="">Choose later</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-col gap-[6px]">
          <label htmlFor="fav-country" className="text-[14px] font-bold">
            Your country (optional)
          </label>
          <select
            id="fav-country"
            className={selectClass}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            <option value="">Leave blank</option>
            {saved.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-[14px] text-ink-muted">
            Only used for a league of fans from your country.
          </span>
        </div>
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
