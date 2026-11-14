import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/identity/auth-client";

/**
 * "Continue with Discord". Only rendered when the server says Discord is set
 * up. A first sign-in lands on Finish signing up; a returning one goes home,
 * or back to `next` (a path `safeNext` let through).
 */
export function DiscordButton({
  variant = "primary",
  next = "/",
}: {
  variant?: "primary" | "quiet" | "secondary";
  next?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="l"
      block
      variant={variant}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { error } = await authClient.signIn.social({
          provider: "discord",
          callbackURL: next,
          newUserCallbackURL: "/welcome",
          errorCallbackURL: "/auth-error",
        });
        // On success the browser leaves for Discord.
        if (error) setBusy(false);
      }}
    >
      Continue with Discord
    </Button>
  );
}
