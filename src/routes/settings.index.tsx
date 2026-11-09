import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  FormMessage,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";
import {
  LinkRow,
  Panel,
  saveMessage,
  SettingsGroup,
} from "@/components/settings-parts";
import { ThemeChoice } from "@/components/theme-choice";
import { Switch } from "@/components/ui/switch";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { useHydrated } from "@/lib/use-hydrated";
import { getSettings, saveSpoilerSetting } from "@/server/account";

export const Route = createFileRoute("/settings/")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Settings · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getSettings(),
  component: Settings,
});

/**
 * Settings (wave 4): Spoilers, Favorites, Appearance, and Account and
 * privacy. Push notifications join in M7.
 */
function Settings() {
  const settings = Route.useLoaderData();
  const hydrated = useHydrated();
  const [hide, setHide] = useState(settings.spoilerProtection);
  const [version, setVersion] = useState(settings.version);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string>();

  async function saveSpoilers(next: boolean) {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setMessage(undefined);
    setHide(next);
    try {
      const result = await saveSpoilerSetting({
        data: { expectedVersion: version, spoilerProtection: next },
      });
      if (result.ok) {
        setVersion(result.version);
        setSaved(true);
      } else {
        setHide(!next);
        setMessage(saveMessage(result.error));
      }
    } catch {
      setHide(!next);
      setMessage("We couldn't save that. Try again in a moment.");
    }
    setSaving(false);
  }

  const usernameSub = settings.nextUsernameChange
    ? `${settings.username} · you can change it again from ${settings.nextUsernameChange}`
    : settings.username;

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/profile">Profile</BackLink>
      </ScreenHeader>
      <Body className="gap-space-3 pt-0">
        <Title>Settings</Title>

        <SettingsGroup id="spoilers-heading" title="Spoilers">
          <Panel className="px-[14px] py-[6px]">
            <Switch
              id="spoiler-protection"
              label="Hide results until I've watched"
              description="Or for 7 days after each session"
              checked={hide}
              disabled={!hydrated || saving}
              onChange={saveSpoilers}
              className="min-h-[56px]"
            />
          </Panel>
          {saved ? (
            <p role="status" className="text-[14px] text-ink-muted">
              Saved.
            </p>
          ) : null}
          <FormMessage>{message}</FormMessage>
        </SettingsGroup>

        <SettingsGroup id="favorites-heading" title="Favorites">
          <Panel>
            <LinkRow
              href="/settings/favorites"
              label="Favorites"
              sub={settings.favorites ?? "None chosen yet"}
            />
          </Panel>
        </SettingsGroup>

        <SettingsGroup id="appearance-heading" title="Appearance">
          <ThemeChoice />
          <span className="text-[14px] text-ink-muted">
            Kept on this device.
          </span>
        </SettingsGroup>

        <SettingsGroup id="account-heading" title="Account and privacy">
          <Panel>
            <LinkRow
              href="/settings/username"
              label="Username"
              sub={usernameSub}
            />
            <LinkRow
              href="/settings/sign-in"
              label="Sign-in methods"
              sub={settings.methods}
            />
            <LinkRow
              href="/settings/security"
              label="Password and security"
              sub="Change your password"
            />
            <LinkRow
              href="/settings/data"
              label="Download my data"
              sub="A file with everything you've posted and played"
            />
            <LinkRow
              href="/settings/delete"
              label="Delete my account"
              sub="Your posts stay, shown as “deleted user”"
              danger
            />
          </Panel>
        </SettingsGroup>
      </Body>
    </Screen>
  );
}
