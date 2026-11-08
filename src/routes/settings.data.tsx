import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  FormMessage,
  Notice,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";
import { Help } from "@/components/settings-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { getDataExport, requestMyExport } from "@/server/account";

export const Route = createFileRoute("/settings/data")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Download my data · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getDataExport(),
  component: DataExport,
});

const REFUSALS: Record<string, string> = {
  export_too_soon: "You can ask for a new copy once a day.",
  export_pending: "Your copy is already on its way.",
  read_only: "This session is read-only.",
};

/**
 * The data export (DM 6.7): ask, wait for the job ("Ready within a few
 * hours"; the website can't wake the scheduler), then download until the
 * link expires after 7 days.
 */
function DataExport() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();

  async function request() {
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await requestMyExport();
      if (result.ok) await router.invalidate();
      else setMessage(REFUSALS[result.error] ?? "We couldn't ask for it.");
    } catch {
      setMessage("We couldn't ask for it. Try again in a moment.");
    }
    setWorking(false);
  }

  const canAsk = state.status !== "pending" && state.status !== "ready";

  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/settings">Settings</BackLink>
      </ScreenHeader>
      <Body>
        <Title>Download my data</Title>
        <Help>
          One file with your account, profile, teams, leagues and sign-ins.
          Posts and chat join it when the forum opens.
        </Help>

        {state.status === "pending" ? (
          <Notice>
            Ready within a few hours. We&apos;ll email you a link too.
          </Notice>
        ) : null}
        {state.status === "ready" ? (
          <div className="flex flex-col gap-space-2">
            <a
              href={state.url}
              download
              className={buttonVariants({ size: "l", block: true })}
            >
              Download the file
            </a>
            <span className="text-[14px] text-ink-muted">
              Works until {state.worksUntil}. You can ask for a new copy once a
              day.
            </span>
          </div>
        ) : null}
        {state.status === "expired" ? (
          <Help>Your last copy has expired. Ask for a new one.</Help>
        ) : null}
        {state.status === "failed" ? (
          <Help>Your last copy didn&apos;t finish. Ask for it again.</Help>
        ) : null}

        <FormMessage>{message}</FormMessage>
        {canAsk ? (
          <Button
            type="button"
            size="l"
            block
            variant={state.status === "none" ? "primary" : "secondary"}
            disabled={working}
            onClick={request}
          >
            Request my data
          </Button>
        ) : null}
      </Body>
    </Screen>
  );
}
