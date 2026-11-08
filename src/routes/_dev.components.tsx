import { useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { Toast } from "@/components/ui/toast";

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

function Components() {
  const [toast, setToast] = useState(true);
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
