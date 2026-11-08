import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  BottomBar,
  FormMessage,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";
import { FavoritesFields } from "@/components/favorites-fields";
import { Help, saveMessage } from "@/components/settings-parts";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { getFavoriteSettings, saveFavoriteSettings } from "@/server/account";

export const Route = createFileRoute("/settings/favorites")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Favorites · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getFavoriteSettings(),
  component: Favorites,
});

/** The onboarding Step 1 fields, saved in place. */
function Favorites() {
  const saved = Route.useLoaderData();
  const [value, setValue] = useState({
    team: saved.favoriteConstructorId ?? "",
    driver: saved.favoriteDriverId ?? "",
    country: saved.countryCode ?? "",
  });
  const [version, setVersion] = useState(saved.version);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setDone(false);
    setMessage(undefined);
    try {
      const result = await saveFavoriteSettings({
        data: {
          expectedVersion: version,
          favoriteConstructorId: value.team || null,
          favoriteDriverId: value.driver || null,
          countryCode: value.country || null,
        },
      });
      if (result.ok) {
        setVersion(result.version);
        setDone(true);
      } else {
        setMessage(saveMessage(result.error));
      }
    } catch {
      setMessage("We couldn't save that. Try again in a moment.");
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
        onSubmit={save}
        className="flex flex-1 flex-col"
      >
        <Body>
          <Title>Favorites</Title>
          <Help>
            Your favorites put you in a fans&apos; league for that team and
            driver.
          </Help>
          <FavoritesFields
            value={value}
            onChange={(next) => {
              setValue(next);
              setDone(false);
            }}
            choices={saved.choices}
            countries={saved.countries}
          />
          {done ? (
            <p role="status" className="text-[16px] font-semibold">
              Saved.
            </p>
          ) : null}
          <FormMessage>{message}</FormMessage>
        </Body>
        <BottomBar>
          <Button type="submit" size="l" block disabled={working}>
            Save
          </Button>
        </BottomBar>
      </form>
    </Screen>
  );
}
