import { useState } from "react";
import { Button } from "@/components/ui/button";
import { stopImpersonation } from "@/server/account";

/**
 * Shown on every page while an admin is looking through someone's session
 * (DM 6.4, ruling 51a). Stop ends it and puts the admin's own session back,
 * then reloads home as the admin.
 */
export function ImpersonationBanner({ username }: { username: string }) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function stop() {
    if (working) return;
    setWorking(true);
    setFailed(false);
    try {
      await stopImpersonation();
    } catch {
      setWorking(false);
      setFailed(true);
      return;
    }
    window.location.assign("/");
  }

  return (
    <section
      aria-label="Impersonation"
      className="sticky top-0 z-10 border-b-2 border-ink bg-volt text-on-volt"
    >
      <div className="mx-auto flex w-full max-w-[480px] items-center justify-between gap-space-3 px-space-4 py-space-2">
        <p className="min-w-0 text-[16px] leading-[20px] font-bold">
          Viewing as {username}.{" "}
          <span className="font-semibold">Read-only.</span>
          {failed ? (
            <span role="alert" className="block font-semibold">
              That didn&apos;t work. Try again.
            </span>
          ) : null}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="border-on-volt text-on-volt"
          disabled={working}
          onClick={stop}
        >
          Stop
        </Button>
      </div>
    </section>
  );
}
