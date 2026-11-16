import { useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import { cn } from "@/lib/utils";
import type { HomeState, SeasonBlock } from "@/play/home";
import { leagueSubtitle, moveWords, rankFigure } from "./league-words";
import {
  sectionTitle,
  useViewerTimeZone,
  WeekendCountdown,
} from "./weekend-hub";
import { ordinal, weekendDates } from "./weekend-words";

const card =
  "flex items-center justify-between gap-space-3 rounded-radius-m bg-surface-raised px-[14px] py-space-3 text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const eyebrow =
  "text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";

type HomeScreenProps = {
  home: HomeState;
  /** "Show it": these sessions, on this page only. */
  show: (sessionIds: string[]) => void;
  /** "Mark as watched": stored, so every page shows it. */
  markWatched: (sessionIds: string[]) => Promise<{ ok: boolean }>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

/** The board's "opens" chevron, beside a text label. */
function Chevron() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** "2,214 pts". */
const pts = (n: number) => `${n.toLocaleString("en-GB")} pts`;

/**
 * Your season (wave 3): the first team's total, global rank and last race,
 * which opens the breakdown (the team, before any points). While the latest event is hidden, all three are
 * covered (decision 2): each one includes it.
 */
function Season({
  season,
  show,
  onMarkWatched,
}: {
  season: SeasonBlock;
  show: (ids: string[]) => void;
  onMarkWatched: (ids: string[]) => void;
}) {
  const title = (
    <span className={eyebrow}>Your season · {season.teamName}</span>
  );
  if (season.hidden) {
    const { hidden } = season;
    return (
      <section aria-label="Your season" className="flex flex-col gap-space-2">
        {title}
        <SpoilerCover
          hidden
          title={`${hidden.name.replace(/ Grand Prix$/, "")} — standings are in`}
          body="Your season total and rank include it. You haven't marked it as watched."
          onReveal={() => show(hidden.sessionIds)}
          onMarkWatched={() => onMarkWatched(hidden.sessionIds)}
        />
      </section>
    );
  }
  return (
    <a
      href={
        season.lastEvent !== null
          ? `/team/${season.slot}/points`
          : `/team/${season.slot}`
      }
      aria-label={`Your season · ${season.teamName}`}
      className={card}
    >
      <span className="flex min-w-0 flex-col gap-[2px]">
        {title}
        {season.total === null ? (
          <span className="text-[16px] leading-[22px] text-ink-muted">
            Your points show here after your first race.
          </span>
        ) : (
          <>
            <span className="font-numeric text-[22px] leading-[26px] font-bold">
              {pts(season.total)}
            </span>
            {season.rank !== null ? (
              <span className="text-[14px] text-ink-muted">
                Global {ordinal(season.rank)}
                {season.rankOf !== null
                  ? ` of ${season.rankOf.toLocaleString("en-GB")}`
                  : ""}
              </span>
            ) : null}
          </>
        )}
      </span>
      {season.lastEvent !== null ? (
        <span className="flex shrink-0 flex-col items-end gap-[2px]">
          <span className="text-[14px] text-ink-muted">Last race</span>
          <span className="font-numeric text-[18px] font-bold">
            {pts(season.lastEvent)}
          </span>
        </span>
      ) : null}
    </a>
  );
}

/**
 * Home for someone signed in (wave 3's "Home in race week"): the weekend,
 * which opens the hub, its countdown, your season and your leagues. The
 * forum's threads join in M7.
 */
export function HomeScreen({
  home,
  show,
  markWatched,
  reload,
}: HomeScreenProps) {
  const timeZone = useViewerTimeZone(home.timeZone);
  const [failed, setFailed] = useState(false);
  const { weekend, season } = home;

  const onMarkWatched = async (ids: string[]) => {
    setFailed(false);
    try {
      const done = await markWatched(ids);
      if (!done.ok) setFailed(true);
      else await reload();
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4">
      <h1 className="sr-only">Home</h1>
      <span
        aria-hidden="true"
        className="font-display text-[24px] leading-[28px] lg:hidden"
      >
        GRIDLOCKED
      </span>

      {weekend ? (
        <>
          <a
            href="/weekend"
            className={cn(
              "flex flex-col gap-[2px] text-ink no-underline",
              "rounded-radius-m outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
            )}
          >
            <span className={eyebrow}>
              Round {weekend.round} · {weekendDates(weekend.sessions, timeZone)}
            </span>
            <span className="flex items-center justify-between gap-space-2">
              <span className="font-display text-[32px] leading-[34px] uppercase">
                {weekend.name}
              </span>
              <Chevron />
            </span>
          </a>
          <WeekendCountdown
            weekend={weekend}
            now={home.now}
            timeZone={timeZone}
            zoneLabel="your time"
            lockLabel="Locks in"
            onZero={() => void reload()}
          />
        </>
      ) : null}

      {failed ? (
        <p
          role="alert"
          className="m-0 rounded-radius-m bg-surface-raised p-space-3 text-[16px] leading-[22px] font-semibold"
        >
          {"That wasn't marked as watched. Try again."}
        </p>
      ) : null}

      {season ? (
        <Season
          season={season}
          show={show}
          onMarkWatched={(ids) => void onMarkWatched(ids)}
        />
      ) : (
        <a href="/team" className={card}>
          <span className="flex flex-col gap-[2px]">
            <span className={eyebrow}>Your season</span>
            <span className="text-[16px] leading-[22px] font-bold">
              Build your team
            </span>
          </span>
          <Chevron />
        </a>
      )}

      {home.leagues.length > 0 ? (
        <section
          aria-labelledby="home-leagues"
          className="flex flex-col gap-space-2"
        >
          <h2 id="home-leagues" className={sectionTitle}>
            LEAGUES
          </h2>
          <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
            {home.leagues.map((league) => (
              <li key={`${league.leagueId}:${league.teamId}`}>
                <AssetRow
                  title={league.name}
                  subtitle={leagueSubtitle(league, false)}
                  figure={rankFigure(league)}
                  secondary={moveWords(league.move)}
                  tinted={false}
                  href={`/leagues/${league.slug}`}
                />
              </li>
            ))}
          </ul>
          <a href="/leagues" className={card}>
            <span className="text-[16px] leading-[22px] font-bold">
              All your leagues
            </span>
            <Chevron />
          </a>
        </section>
      ) : null}
    </div>
  );
}
