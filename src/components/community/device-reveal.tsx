import { useEffect, useId } from "react";
import { Switch } from "@/components/ui/switch";
import { browserReveal } from "@/spoilers/browser-reveal";

/**
 * A visitor's "Show results everywhere on this device" (HLD §7.3). The
 * choice stays in this browser; turning it on, or arriving with it on,
 * reveals the page in its history entry (M9 Task 4), so the default page
 * never carries what it hides and the address never carries the reveal.
 */
export function useDeviceReveal({
  visitor,
  hasHidden,
  showAll,
  showEverything,
}: {
  visitor: boolean;
  hasHidden: boolean;
  showAll: boolean;
  showEverything: () => void;
}) {
  useEffect(() => {
    if (visitor && hasHidden && !showAll && browserReveal.get() === "all") {
      showEverything();
    }
    // The navigation is the page's own; it only needs to run when these do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitor, hasHidden, showAll]);
}

export function DeviceRevealSwitch({
  on,
  onShowAll,
  onShowSafe,
}: {
  on: boolean;
  onShowAll: () => void;
  onShowSafe: () => void;
}) {
  const id = useId();
  return (
    <Switch
      id={id}
      label="Show results everywhere on this device"
      description="Only in this browser. Sign in to choose session by session."
      checked={on}
      onChange={(next) => {
        browserReveal.set(next ? "all" : "safe");
        if (next) onShowAll();
        else onShowSafe();
      }}
    />
  );
}
