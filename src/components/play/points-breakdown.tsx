import { useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { EmptyState } from "@/components/ui/empty-state";
import { PointsPill } from "@/components/ui/points-pill";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  BreakdownExtra,
  BreakdownPage,
  BreakdownRow,
} from "@/play/breakdown";
import { DriverSheet, signed } from "./driver-sheet";

const sectionTitle =
  "m-0 font-display text-[18px] leading-[22px] font-normal tracking-[0.02em] uppercase";
const link =
  "inline-flex min-h-[44px] items-center text-[16px] font-bold text-heat-text underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

type PointsBreakdownProps = {
  page: BreakdownPage;
  /** "Show it": this session, on this page only. */
  show: (sessionId: string) => void;
  /** "Mark as watched": stored, so every page shows it. */
  markWatched: (sessionIds: string[]) => Promise<{ ok: boolean }>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

/** The board's back chevron. */
function Back() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

/** A Boost, a chip or the transfer penalty. */
function ExtraRow({ extra }: { extra: BreakdownExtra }) {
  return (
    <li className="flex min-h-[52px] items-center justify-between gap-space-3 rounded-radius-m border border-line px-[14px] py-[6px]">
      <span className="flex min-w-0 flex-col">
        <span className="text-[16px] leading-[20px] font-bold">
          {extra.label}
        </span>
        <span className="text-[14px] text-ink-muted">{extra.why}</span>
      </span>
      <span
        className={cn(
          "shrink-0 font-numeric text-[18px] font-bold",
          extra.points > 0 ? "text-rise" : extra.points < 0 ? "text-fall" : "",
        )}
      >
        {signed(extra.points)}
      </span>
    </li>
  );
}

/**
 * One weekend, by session, with a correction note (wave 3): a tab per
 * scored session, one row per asset with one number and a plain reason, and
 * the team's own lines in their own section. A row opens its line-by-line
 * sheet. A session the viewer hasn't seen is a SpoilerCover; the server sent
 * none of its figures.
 */
export function PointsBreakdown({
  page,
  show,
  markWatched,
  reload,
}: PointsBreakdownProps) {
  const { breakdown, team } = page;
  const scored = breakdown?.sessions.filter((s) => s.scored) ?? [];
  const [tab, setTab] = useState<string | null>(null);
  const [open, setOpen] = useState<BreakdownRow | null>(null);
  const [failed, setFailed] = useState(false);

  const back = (
    <a href={`/team/${team.slot}`} className={cn(link, "gap-[4px] text-ink")}>
      <Back />
      {team.name}
    </a>
  );

  if (!breakdown || scored.length === 0) {
    return (
      <div className="flex flex-col px-space-4 pt-space-2">
        {back}
        <EmptyState
          headingLevel={1}
          title="No points yet"
          body="Your points show here after your first race."
        />
      </div>
    );
  }

  // The latest scored session, unless one was picked.
  const current =
    breakdown.sessions.find((s) => s.id === tab) ?? scored.at(-1)!;
  const sessionExtras = breakdown.extras.filter(
    (e) => e.sessionId === current.id,
  );
  const eventExtras = breakdown.extras.filter((e) => e.sessionId === null);
  const extras = [...sessionExtras, ...eventExtras];
  const name = current.label.toLowerCase();

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

  const otherRounds = breakdown.rounds.filter(
    (r) => r !== breakdown.event.round,
  );

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-2 pb-space-6">
      {back}
      <div className="flex items-end justify-between gap-space-3">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase">
            Round {breakdown.event.round} · {breakdown.event.name}
          </span>
          <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
            Your points
          </h1>
        </div>
        {breakdown.total !== null ? (
          <PointsPill points={breakdown.total} status={breakdown.status} />
        ) : null}
      </div>

      {breakdown.correction ? (
        <div className="flex flex-col gap-[4px] rounded-radius-m bg-surface-raised px-[14px] py-space-3">
          <span className="text-[16px] leading-[22px] font-bold">
            Corrected after the session
          </span>
          <span className="text-[14px] leading-[20px] text-ink-muted">
            {breakdown.correction}
          </span>
        </div>
      ) : null}

      {failed ? (
        <p
          role="alert"
          className="m-0 rounded-radius-m bg-surface-raised p-space-3 text-[16px] leading-[22px] font-semibold"
        >
          {"That wasn't marked as watched. Try again."}
        </p>
      ) : null}

      {breakdown.sessions.length > 1 ? (
        <Tabs
          label="Session"
          items={breakdown.sessions.map((s) => ({ id: s.id, label: s.label }))}
          value={current.id}
          onChange={setTab}
        />
      ) : null}

      {!current.scored ? (
        <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
          Your points from {name} show here once it&apos;s scored.
        </p>
      ) : !current.revealed ? (
        <SpoilerCover
          hidden
          title={`${current.label} — scores are in`}
          body={`Your points from ${name} are ready. You haven't marked ${name} as watched.`}
          onReveal={() => show(current.id)}
          onMarkWatched={() => void onMarkWatched([current.id])}
        />
      ) : (
        <section
          aria-labelledby="session-points"
          className="flex flex-col gap-space-2"
        >
          <div className="flex items-baseline justify-between">
            <h2 id="session-points" className={sectionTitle}>
              {current.label}
            </h2>
            <span className="font-numeric text-[18px] font-bold">
              {current.points} pts
            </span>
          </div>
          <ul
            aria-label={`${current.label} points`}
            className="m-0 flex list-none flex-col gap-space-2 p-0"
          >
            {current.rows.map((row) => (
              <li key={row.assetId}>
                <AssetRow
                  code={row.code}
                  teamColor={row.color}
                  title={row.title}
                  subtitle={row.reason}
                  figure={`${row.points} pts`}
                  badges={row.badges.map((label) => ({
                    tone: "boost",
                    label,
                  }))}
                  onClick={() => setOpen(row)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {extras.length > 0 ? (
        <section
          aria-labelledby="boosts-and-transfers"
          className="flex flex-col gap-space-2"
        >
          <h2
            id="boosts-and-transfers"
            className={cn(sectionTitle, "mt-[4px]")}
          >
            Boosts and transfers
          </h2>
          <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
            {extras.map((extra, i) => (
              <ExtraRow key={`${extra.kind}-${i}`} extra={extra} />
            ))}
          </ul>
        </section>
      ) : null}

      {otherRounds.length > 0 ? (
        <nav aria-label="Other rounds" className="flex flex-col gap-space-1">
          <h2 className={cn(sectionTitle, "mt-[4px]")}>Other rounds</h2>
          <p className="m-0 flex flex-wrap gap-x-space-4">
            {otherRounds.map((round) => (
              <a
                key={round}
                href={`/team/${team.slot}/points?round=${round}`}
                className={link}
              >
                Round {round}
              </a>
            ))}
          </p>
        </nav>
      ) : null}

      <DriverSheet
        open={open !== null}
        onClose={() => setOpen(null)}
        row={open}
        session={current.label}
        extras={sessionExtras.filter(
          (e) => open !== null && e.assetId === open.assetId,
        )}
      />
    </div>
  );
}
