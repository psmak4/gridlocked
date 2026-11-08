import { createFileRoute } from "@tanstack/react-router";
import { Screen, linkClass } from "@/components/account-layout";
import { DiscordButton } from "@/components/discord-button";
import { Button } from "@/components/ui/button";
import { getSignInOptions } from "@/server/account";

export const Route = createFileRoute("/sign-up/")({
  head: () => ({ meta: [{ title: "Sign up · Gridlocked" }] }),
  loader: () => getSignInOptions(),
  component: ChooseAWayIn,
});

/** The brand moment: the cover's heat block, checkers and volt tile. */
function Cover() {
  const checkers = [0, 48, 96, 144, 192];
  return (
    <svg
      viewBox="0 0 390 190"
      className="block h-auto w-full shrink-0"
      aria-hidden="true"
    >
      <rect
        className="fill-heat"
        x="0"
        y="-16"
        width="240"
        height="190"
        rx="16"
      />
      <g className="fill-on-heat">
        {checkers.map((x) => (
          <rect key={`a${x}`} x={x} y="126" width="24" height="24" />
        ))}
        {checkers.map((x) => (
          <rect key={`b${x}`} x={x + 24} y="150" width="24" height="24" />
        ))}
      </g>
      <rect
        className="fill-volt"
        x="264"
        y="24"
        width="126"
        height="96"
        rx="16"
      />
    </svg>
  );
}

function ChooseAWayIn() {
  const { discord } = Route.useLoaderData();
  return (
    <Screen>
      <Cover />
      <main className="flex flex-col gap-[14px] px-space-4 pt-space-5">
        <div className="flex flex-col gap-[6px]">
          <h1 className="font-display text-[48px] leading-[48px] font-normal uppercase">
            GRIDLOCKED
          </h1>
          <p className="text-[16px] leading-[24px]">
            A fan home for race weekends: a forum that knows the calendar, live
            session chat and a fantasy game.
          </p>
        </div>
        <div className="mt-space-2 flex flex-col gap-[10px]">
          {discord ? <DiscordButton /> : null}
          <Button
            staticLink
            href="/sign-up/email"
            variant={discord ? "secondary" : "primary"}
            size="l"
            block
          >
            Sign up with email
          </Button>
          <Button
            staticLink
            href="/sign-in?mode=link"
            variant="quiet"
            size="l"
            block
          >
            Email me a sign-in link
          </Button>
        </div>
        <p className="text-center text-[16px]">
          Already have an account?{" "}
          <a href="/sign-in" className={linkClass}>
            Sign in
          </a>
        </p>
      </main>
      <p className="mt-auto px-space-4 pt-space-3 text-[14px] leading-[20px] text-ink-muted">
        You&apos;ll accept the terms in the next step. You must be 16 or older.
      </p>
    </Screen>
  );
}
