import { useEffect, useState } from "react";
import type { PushState } from "@/lib/push-client";
import { Button } from "./ui/button";
import { Sheet } from "./ui/sheet";

/** What the sheet says for each state (wave 4: "Turn on push"). */
export const PUSH_WORDS: Record<
  PushState | "no_key",
  { body: string; action?: "on" | "off" }
> = {
  off: {
    body: "Get a buzz when your team's lock is near, when scores are in, and when someone replies to you. A push never says who won, so results stay hidden until you've watched.",
    action: "on",
  },
  on: {
    body: "Push is on for this device: lock reminders, scores and team news.",
    action: "off",
  },
  install_first: {
    body: "On iPhone and iPad, add Gridlocked to your home screen first: tap Share, then Add to Home Screen. Open it from there and turn push on.",
  },
  denied: {
    body: "Notifications are blocked for this site. Allow them in your browser's settings, then come back.",
  },
  unsupported: {
    body: "This browser can't show push notifications.",
  },
  no_key: {
    body: "Push isn't available yet.",
  },
};

/** One-word state for a Settings row. */
export const pushRowWords = (state: PushState | "no_key" | null) =>
  state === "on" ? "On for this device" : "Off";

/**
 * "Turn on push": the sheet behind the card on Notifications and the row in
 * Settings. `load` reads the browser's state and the site's key when it
 * opens; `turnOn` and `turnOff` do the rest and answer the new state.
 */
export function PushSheet({
  open,
  onClose,
  load,
  turnOn,
  turnOff,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<PushState | "no_key">;
  turnOn: () => Promise<PushState | "no_key">;
  turnOff: () => Promise<PushState | "no_key">;
}) {
  const [state, setState] = useState<PushState | "no_key" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    load()
      .then((next) => live && setState(next))
      .catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, [open, load]);

  async function act(fn: () => Promise<PushState | "no_key">) {
    setBusy(true);
    setFailed(false);
    try {
      setState(await fn());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const words = state ? PUSH_WORDS[state] : null;
  return (
    <Sheet
      open={open}
      onClose={() => {
        setFailed(false);
        onClose();
      }}
      title={state === "on" ? "Push notifications" : "Turn on push"}
      actions={
        words?.action === "on" ? (
          <Button block disabled={busy} onClick={() => void act(turnOn)}>
            Turn on
          </Button>
        ) : words?.action === "off" ? (
          <Button
            block
            variant="secondary"
            disabled={busy}
            onClick={() => void act(turnOff)}
          >
            Turn off
          </Button>
        ) : null
      }
    >
      <p role="status" className="m-0 text-[16px] leading-[24px]">
        {words ? words.body : "Checking this device…"}
      </p>
      {failed ? (
        <p role="alert" className="m-0 text-[14px] text-heat-text">
          {"That didn't work. Try it again."}
        </p>
      ) : null}
    </Sheet>
  );
}
