import { useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AssetRow } from "@/components/ui/asset-row";
import { Badge } from "@/components/ui/badge";
import { BottomNav } from "@/components/ui/bottom-nav";
import { BudgetMeter } from "@/components/ui/budget-meter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CountdownBlock } from "@/components/ui/countdown-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, iconNames } from "@/components/ui/icons";
import { PointsPill } from "@/components/ui/points-pill";
import { Sheet } from "@/components/ui/sheet";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import { Switch } from "@/components/ui/switch";
import { Tabs } from "@/components/ui/tabs";
import { TeamBadge } from "@/components/ui/team-badge";
import { TextField } from "@/components/ui/text-field";
import { Toast } from "@/components/ui/toast";
import { teamColors2026 } from "@/design/tokens";

/**
 * A page of every component, for local builds and the e2e tests. A deployed
 * build never sets VITE_LOCAL_DB, so the route 404s there.
 */
const enabled = import.meta.env.VITE_LOCAL_DB === "1" || import.meta.env.DEV;

export const Route = createFileRoute("/_dev/components")({
  beforeLoad: () => {
    if (!enabled) throw notFound();
  },
  component: Components,
});

const MCL = teamColors2026.MCL ?? "#ff8000";
const FER = teamColors2026.FER ?? "#e8002d";

const navItems = [
  { id: "home", label: "Home", href: "/components", icon: "home" as const },
  { id: "team", label: "Team", href: "/components", icon: "team" as const },
  {
    id: "leagues",
    label: "Leagues",
    href: "/components",
    icon: "leagues" as const,
  },
  {
    id: "profile",
    label: "Profile",
    href: "/components",
    icon: "profile" as const,
  },
];

function Components() {
  const [toast, setToast] = useState(true);
  const [tab, setTab] = useState("drivers");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [spoilerHidden, setSpoilerHidden] = useState(true);
  return (
    <main className="flex max-w-[480px] flex-col gap-space-4 p-space-4">
      <h1 className="font-display text-[32px] uppercase">Components</h1>
      <div className="flex flex-wrap gap-space-2">
        <Button>Save team</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="quiet" size="l">
          Later
        </Button>
        <Button disabled>Disabled</Button>
        <Button staticLink href="/">
          Sign in
        </Button>
      </div>
      <div className="flex flex-wrap gap-space-2">
        <Badge>Neutral</Badge>
        <Badge tone="boost">2x</Badge>
        <Badge tone="caution">Doubtful</Badge>
        <Badge tone="live">Live</Badge>
      </div>
      <TextField id="name" label="Team name" hint="3 to 20 letters" />
      <TextField
        id="email"
        type="email"
        label="Email"
        error="That email is not valid."
      />
      <Checkbox id="terms" label="I accept the terms" hint="Read them first" />
      <Switch
        id="spoilers"
        label="Hide results until I've watched"
        description="Spoiler protection"
      />
      <h2 className="font-display text-[24px] uppercase">Second set</h2>
      <div className="flex flex-wrap items-center gap-space-2">
        <TeamBadge code="MCL" color={MCL} teamName="McLaren" />
        <TeamBadge code="FER" color={FER} teamName="Ferrari" />
        <TeamBadge
          code="MCL"
          color={MCL}
          teamName="McLaren"
          variant="outline"
        />
        <TeamBadge code="FER" color={FER} teamName="Ferrari" size="s" />
      </div>
      <CountdownBlock
        label="Locks in"
        value="1D 04:12"
        stats={[
          { value: "$2.2M", label: "Bank" },
          { value: "1/2", label: "Transfers" },
        ]}
      />
      <BudgetMeter spent={97.8} />
      <BudgetMeter spent={101.4} />
      <Tabs
        label="Pick from"
        items={[
          { id: "drivers", label: "Drivers" },
          { id: "constructors", label: "Constructors" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="flex flex-col gap-space-2">
        <AssetRow
          code="MCL"
          teamColor={MCL}
          title="Norris"
          subtitle="McLaren"
          figure="$26.6M"
          delta={0.2}
          secondary="38 pts"
          onClick={() => {}}
        />
        <AssetRow
          code="FER"
          teamColor={FER}
          title="Leclerc"
          subtitle="Ferrari"
          figure="$24.1M"
          delta={-0.1}
          badges={[{ tone: "boost", label: "2x" }]}
          href="/components"
        />
        <AssetRow
          code="FER"
          teamColor={FER}
          title="Hamilton"
          subtitle="$0.4M over budget"
          figure="$23.9M"
          disabled
          onClick={() => {}}
        />
        <AssetRow
          title="Ferrari"
          subtitle="Constructor"
          figure="$27.0M"
          tinted={false}
        />
      </div>
      <div className="flex flex-wrap gap-space-2">
        <PointsPill points={38} status="provisional" />
        <PointsPill points={41} status="final" />
      </div>
      <SpoilerCover
        hidden={spoilerHidden}
        title="Race — results are in"
        body="You haven’t marked this session as watched."
        onReveal={() => setSpoilerHidden(false)}
        onMarkWatched={() => setSpoilerHidden(false)}
      >
        <PointsPill points={44} status="final" />
      </SpoilerCover>
      <EmptyState
        title="No leagues yet"
        body="Leagues you join or create show here."
        action={<Button>Join with a code</Button>}
      />
      <Button variant="secondary" onClick={() => setSheetOpen(true)}>
        Open the chip sheet
      </Button>
      <Sheet
        title="Play Overdrive"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        actions={
          <Button block onClick={() => setSheetOpen(false)}>
            Play it
          </Button>
        }
      >
        <p className="m-0 font-sans text-[16px]">
          Pick the driver whose points count double this weekend.
        </p>
      </Sheet>
      <div className="flex gap-space-3 text-ink" aria-label="Icons" role="img">
        {iconNames.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </div>
      <BottomNav items={navItems} active="team" />
      {toast ? (
        <Toast
          onDismiss={() => setToast(false)}
          actionLabel="Undo"
          onAction={() => {}}
        >
          Team saved
        </Toast>
      ) : null}
    </main>
  );
}
