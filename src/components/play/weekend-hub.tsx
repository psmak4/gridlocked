import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountdownBlock } from "@/components/ui/countdown-block";
import { Tabs } from "@/components/ui/tabs";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import type { Weekend, WeekendPage } from "@/play/weekend";
import { lockCountdown } from "./team-words";
import { useTimeLeft } from "./use-time-left";
import { browserTimeZone, dayAndTime, sessionRow } from "./weekend-words";

export const sectionTitle =
  "m-0 font-display text-[18px] leading-[22px] font-normal tracking-[0.02em]";

/**
 * The viewer's zone: their profile's when signed in, else the browser's
 * once hydrated (the server, and the first render, use UTC).
 */
export function useViewerTimeZone(profileZone: string | null): string {
  const hydrated = useHydrated();
  if (profileZone) return profileZone;
  return hydrated ? browserTimeZone() : "UTC";
}

type WeekendCountdownProps = {
  weekend: Weekend;
  now: string;
  timeZone: string;
  /** "your time" or "track time", under the lock's day and time. */
  zoneLabel: string;
  /** Home says "Locks in", the hub "Your team locks in". */
  lockLabel: string;
  /** Reads the page again, once, when the countdown reaches zero. */
  onZero?: () => void;
};

/**
 * The weekend's heat block: the lock countdown before the lock, then the
 * race's start, then where the race is.
 */
export function WeekendCountdown({
  weekend,
  now,
  timeZone,
  zoneLabel,
  lockLabel,
  onZero,
}: WeekendCountdownProps) {
  const race = weekend.sessions.find((s) => s.kind === "race") ?? null;
  const lockLeft = useTimeLeft(weekend.lockAt, now) ?? 0;
  const raceLeft = useTimeLeft(race?.start ?? null, now);
  const fired = useRef(false);
  const before = Date.parse(now) < Date.parse(weekend.lockAt);
  useEffect(() => {
    if (before && lockLeft <= 0 && !fired.current) {
      fired.current = true;
      onZero?.();
    }
  }, [before, lockLeft, onZero]);

  if (lockLeft > 0) {
    const at = dayAndTime(weekend.lockAt, timeZone);
    return (
      <CountdownBlock
        label={lockLabel}
        value={lockCountdown(lockLeft)}
        stats={[{ value: `${at.short} ${at.time}`, label: zoneLabel }]}
      />
    );
  }
  if (race && raceLeft !== null && raceLeft > 0) {
    const at = dayAndTime(race.start, timeZone);
    return (
      <CountdownBlock
        label="Race starts in"
        value={lockCountdown(raceLeft)}
        stats={[{ value: `${at.short} ${at.time}`, label: zoneLabel }]}
      />
    );
  }
  const over = race?.state === "ended" || race?.state === "ended_early";
  return (
    <CountdownBlock
      label={`Round ${weekend.round}`}
      value={over ? "FINISHED" : "RACE ON"}
    />
  );
}

type WeekendHubProps = {
  page: WeekendPage & { weekend: Weekend };
  /** "Mark as watched": stored, so every page shows it. */
  markWatched: (sessionIds: string[]) => Promise<{ ok: boolean }>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

/**
 * The weekend hub (wave 3's "Weekend hub before lock", and wave 2's with
 * qualifying not watched): the round, the countdown, the sessions in your
 * time or the track's, "Locks team" on the locking session, and Mark as
 * watched on a scored session you haven't seen. It shows no score.
 */
export function WeekendHub({ page, markWatched, reload }: WeekendHubProps) {
  const { weekend, signedIn } = page;
  const hydrated = useHydrated();
  const mine = useViewerTimeZone(page.timeZone);
  const [zone, setZone] = useState<"mine" | "track">("mine");
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timeZone = zone === "mine" ? mine : weekend.circuitTimeZone;
  const zoneLabel = zone === "mine" ? "your time" : "track time";
  const beforeLock = Date.parse(page.now) < Date.parse(weekend.lockAt);
  const rows = weekend.sessions.map((s) => ({
    s,
    words: sessionRow(s, { timeZone, signedIn }),
  }));
  const anyHidden = rows.some((r) => r.words.markWatched);

  const onMarkWatched = async (id: string) => {
    setBusy(id);
    setFailed(false);
    try {
      const done = await markWatched([id]);
      if (!done.ok) setFailed(true);
      else await reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6">
      <div className="flex flex-col gap-[2px]">
        <span className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase">
          Round {weekend.round} · {weekend.circuit}
        </span>
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal break-words uppercase">
          {weekend.name}
        </h1>
      </div>

      <WeekendCountdown
        weekend={weekend}
        now={page.now}
        timeZone={timeZone}
        zoneLabel={zoneLabel}
        lockLabel="Your team locks in"
        onZero={() => void reload()}
      />

      {signedIn || beforeLock ? (
        <Button staticLink href="/team" variant="secondary" block>
          {!signedIn
            ? "Build a team"
            : beforeLock
              ? "Edit my team"
              : "See my team"}
        </Button>
      ) : null}

      <div className="flex items-center justify-between gap-space-3">
        <h2 className={sectionTitle}>SESSIONS</h2>
        <div className="w-[200px]">
          <Tabs
            label="Time zone"
            items={[
              { id: "mine", label: "My time" },
              { id: "track", label: "Track" },
            ]}
            value={zone}
            onChange={(id) => setZone(id === "track" ? "track" : "mine")}
          />
        </div>
      </div>

      {failed ? (
        <p
          role="alert"
          className="m-0 rounded-radius-m bg-surface-raised p-space-3 text-[16px] leading-[22px] font-semibold"
        >
          {"That wasn't marked as watched. Try again."}
        </p>
      ) : null}

      <ul
        aria-label="Sessions"
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {rows.map(({ s, words }) => (
          <li
            key={s.id}
            className={cn(
              "flex min-h-[56px] flex-col gap-space-2 rounded-radius-m px-[14px] py-space-2",
              words.dashed
                ? "border border-dashed border-line-strong bg-transparent"
                : "bg-surface-raised",
            )}
          >
            <div className="flex items-center justify-between gap-space-3">
              <span className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-[6px]">
                  <span className="text-[16px] leading-[20px] font-bold tracking-[0.02em] uppercase">
                    {s.label}
                  </span>
                  {words.badges.map((b) => (
                    <Badge key={b.label} tone={b.tone}>
                      {b.label}
                    </Badge>
                  ))}
                </span>
                <span className="text-[14px] leading-[18px] text-ink-muted">
                  {words.sub}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0",
                  words.rightTone === "time"
                    ? "font-numeric text-[18px] font-bold tabular-nums"
                    : "text-[14px] font-bold",
                  words.rightTone === "heat" && "text-heat-text",
                  words.rightTone === "muted" && "text-ink-muted",
                )}
              >
                {words.right}
              </span>
            </div>
            {words.markWatched ? (
              <Button
                variant="secondary"
                size="m"
                disabled={!hydrated || busy !== null}
                onClick={() => void onMarkWatched(s.id)}
                className="self-start"
              >
                {busy === s.id ? "Marking…" : "Mark as watched"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {anyHidden ? (
        <p className="m-0 text-[14px] leading-[20px] text-ink-muted">
          Spoiler protection is on. Results stay hidden for 7 days unless you
          mark a session as watched.
        </p>
      ) : null}
    </div>
  );
}
