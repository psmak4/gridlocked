import { useState } from "react";
import { selectClass } from "@/components/account-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import type { GameErrorCode } from "@/game/errors";
import { cn } from "@/lib/utils";
import type { StandingRow, StandingsPage } from "@/play/standings";
import { InviteCode } from "./leagues-screen";
import { leagueRefusalWords } from "./league-words";
import { ordinal } from "./weekend-words";

const eyebrow =
  "text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";
const backLink =
  "flex min-h-[44px] items-center self-start text-[16px] font-bold text-ink-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

type Result = { ok: true } | { ok: false; error: GameErrorCode };

type StandingsScreenProps = {
  page: StandingsPage;
  /** The page after `afterRank` (See more), of the table `version` names. */
  more: (
    afterRank: number,
    version: string,
  ) => Promise<StandingsPage | { ok: false; error: GameErrorCode }>;
  /** "Show it": these sessions, on this page only. */
  show: (sessionIds: string[]) => void;
  /** "Mark as watched": stored, so every page shows it. */
  markWatched: (sessionIds: string[]) => Promise<{ ok: boolean }>;
  leave: (data: { leagueId: string; teamId: string }) => Promise<Result>;
  /** After leaving: back to My leagues. */
  onLeft: () => Promise<void>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

const KIND: Record<StandingsPage["league"]["kind"], string> = {
  global: "Global",
  public: "Public",
  private: "Private",
  auto_constructor: "Favorite team",
  auto_driver: "Favorite driver",
  auto_country: "Your country",
};

/** "▲3", "▼1" or "–", and its words for a screen reader. */
function Move({ move }: { move: number | null }) {
  if (move === null || move === 0) {
    return (
      <span className="text-ink-muted">
        <span aria-hidden>–</span>
        <span className="sr-only">no change</span>
      </span>
    );
  }
  return (
    <span className={move > 0 ? "text-rise" : "text-fall"}>
      <span aria-hidden>{move > 0 ? `▲${move}` : `▼${-move}`}</span>
      <span className="sr-only">
        {move > 0 ? `up ${move}` : `down ${-move}`}
      </span>
    </span>
  );
}

const pts = (n: number) => n.toLocaleString("en-GB");

/** The phone list: rank and move, team and manager, points. */
function StandingsList({ rows }: { rows: StandingRow[] }) {
  return (
    <ol
      aria-label="Standings"
      className="m-0 flex list-none flex-col gap-[6px] p-0 lg:hidden"
    >
      {rows.map((r) => (
        <li
          key={r.teamId}
          data-mine={r.mine || undefined}
          className={cn(
            "flex min-h-[52px] items-center gap-space-3 rounded-radius-m bg-surface-raised py-[4px] pr-[14px] pl-[6px]",
            r.mine && "outline-2 -outline-offset-2 outline-ink",
          )}
        >
          <span className="flex w-[44px] shrink-0 flex-col items-center font-numeric">
            <span className="text-[18px] font-bold">{r.rank}</span>
            <span className="text-[12px] font-bold">
              <Move move={r.move} />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-space-2 text-[16px] font-bold break-words">
              {r.teamName}
              {r.mine ? <Badge tone="neutral">You</Badge> : null}
            </span>
            {r.username ? (
              <span className="text-[14px] text-ink-muted">{r.username}</span>
            ) : null}
          </span>
          <span className="font-numeric text-[18px] font-bold">
            {pts(r.points)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** From 1024 px: a real table (wave 3's desktop board). */
function StandingsTable({ rows }: { rows: StandingRow[] }) {
  const th =
    "px-space-3 py-space-2 text-left text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";
  return (
    <table className="hidden w-full border-collapse lg:table">
      <caption className="sr-only">Standings</caption>
      <thead>
        <tr>
          <th scope="col" className={th}>
            Rank
          </th>
          <th scope="col" className={th}>
            Team
          </th>
          <th scope="col" className={th}>
            Manager
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Last race
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.teamId}
            data-mine={r.mine || undefined}
            className={cn(
              "border-t border-line",
              r.mine && "bg-surface outline-2 -outline-offset-2 outline-ink",
            )}
          >
            <td className="px-space-3 py-space-2 font-numeric font-bold">
              {r.rank}{" "}
              <span className="text-[12px]">
                <Move move={r.move} />
              </span>
            </td>
            <th
              scope="row"
              className="px-space-3 py-space-2 text-left font-bold"
            >
              {r.teamName}
              {r.mine ? (
                <>
                  {" "}
                  <Badge tone="neutral">You</Badge>
                </>
              ) : null}
            </th>
            <td className="px-space-3 py-space-2 text-ink-muted">
              {r.username ?? ""}
            </td>
            <td className="px-space-3 py-space-2 text-right font-numeric">
              {r.last === null ? "–" : pts(r.last)}
            </td>
            <td className="px-space-3 py-space-2 text-right font-numeric font-bold">
              {pts(r.points)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The side card: your place, and the gap to the team above. */
function YourPlace({
  row,
  rows,
  through,
}: {
  row: StandingRow;
  rows: StandingRow[];
  through: StandingsPage["through"];
}) {
  const above = rows
    .filter((r) => r.points > row.points)
    .sort((a, b) => a.points - b.points)[0];
  return (
    <section
      aria-label={`${row.teamName} in this league`}
      className="flex flex-col gap-[4px] rounded-radius-m bg-surface-raised p-space-4"
    >
      <span className={eyebrow}>{`${row.teamName} in this league`}</span>
      <span className="font-display text-[40px] leading-[44px] uppercase">
        {ordinal(row.rank)}
      </span>
      {above ? (
        <span className="text-[16px]">
          {`${pts(above.points - row.points)} points behind ${above.teamName}.`}
        </span>
      ) : row.rank === 1 ? (
        <span className="text-[16px]">Top of the table.</span>
      ) : null}
      {row.move ? (
        <span
          className={cn(
            "text-[14px] font-bold",
            row.move > 0 ? "text-rise" : "text-fall",
          )}
        >
          {`${row.move > 0 ? "▲ Up" : "▼ Down"} ${Math.abs(row.move)} ${
            Math.abs(row.move) === 1 ? "place" : "places"
          }${through ? ` after round ${through.round}` : ""}`}
        </span>
      ) : null}
    </section>
  );
}

/** "Leave league", which asks once more; with two teams in it, which one. */
function LeaveLeague({
  league,
  leave,
  onLeft,
}: {
  league: StandingsPage["league"];
  leave: StandingsScreenProps["leave"];
  onLeft: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState(league.myTeams[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const team = league.myTeams.find((t) => t.id === teamId);
  const onLeave = async () => {
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await leave({ leagueId: league.id, teamId });
      if (result.ok) {
        setOpen(false);
        await onLeft();
      } else {
        setMessage(leagueRefusalWords(result.error));
      }
    } catch {
      setMessage(leagueRefusalWords("server_error"));
    } finally {
      setWorking(false);
    }
  };
  return (
    <>
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        Leave league
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={`Leave ${league.name}?`}
        actions={
          <Button
            size="l"
            block
            disabled={working}
            onClick={() => void onLeave()}
          >
            {working ? "Leaving…" : "Leave league"}
          </Button>
        }
      >
        {league.myTeams.length > 1 ? (
          <div className="flex flex-col gap-[6px]">
            <label htmlFor="leave-team" className="text-[14px] font-bold">
              Which of your teams leaves
            </label>
            <select
              id="leave-team"
              className={selectClass}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              {league.myTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="m-0 text-[16px] leading-[22px]">
          {`${team?.name ?? "Your team"} leaves ${league.name}. You can join again with its code.`}
        </p>
        {message ? (
          <p role="alert" className="m-0 text-[16px] font-semibold text-fall">
            {message}
          </p>
        ) : null}
      </Sheet>
    </>
  );
}

/**
 * League standings (wave 3): the league, its code, the table 50 at a time
 * with your rows outlined, See more, and the tiebreak note. While the latest
 * event is hidden, a SpoilerCover replaces the table (M6 decision 2). From
 * 1024 px the table is a real table, with your place beside it.
 */
export function StandingsScreen({
  page,
  more,
  show,
  markWatched,
  leave,
  onLeft,
  reload,
}: StandingsScreenProps) {
  // Pages read with See more belong to the page they followed: a reload
  // (Mark as watched) starts again from its first page.
  // A See more that finds the table changed replaces the first page too
  // (`top`), and says so (`changed`).
  type Loaded = {
    after: StandingsPage;
    top: StandingRow[] | null;
    rows: StandingRow[];
    next: number | null;
    version: string;
    changed: boolean;
  };
  const fresh = (p: StandingsPage): Loaded => ({
    after: p,
    top: null,
    rows: [],
    next: p.next,
    version: p.version,
    changed: false,
  });
  const [loaded, setLoaded] = useState<Loaded>(() => fresh(page));
  const current = loaded.after === page ? loaded : fresh(page);
  const extra = current.rows;
  const next = current.next;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const { league, through } = page;
  const rows = [...(current.top ?? page.rows), ...extra];
  const canLeave =
    (league.kind === "public" || league.kind === "private") &&
    league.myTeams.length > 0;

  const subtitle = [
    league.range ? `Mini-league · ${league.range}` : KIND[league.kind],
    `${pts(league.members)} ${league.members === 1 ? "team" : "teams"}`,
    through ? `after round ${through.round}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const seeMore = async () => {
    if (next === null) return;
    setLoading(true);
    setFailed(false);
    try {
      const result = await more(next, current.version);
      if ("ok" in result) {
        setFailed(true);
      } else if (result.restarted) {
        setLoaded({
          after: page,
          top: result.rows,
          rows: [],
          next: result.next,
          version: result.version,
          changed: true,
        });
      } else {
        setLoaded({
          ...current,
          rows: [...extra, ...result.rows],
          next: result.next,
        });
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const onMarkWatched = async () => {
    try {
      await markWatched(page.hiddenSessionIds);
    } finally {
      await reload();
    }
  };

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6">
      <a href="/leagues" className={backLink}>
        ← Leagues
      </a>
      <div className="flex flex-col gap-[2px]">
        <span className={eyebrow}>{subtitle}</span>
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
          {league.name}
        </h1>
      </div>
      {league.joinCode ? <InviteCode code={league.joinCode} /> : null}

      <div className="flex flex-col gap-space-4 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <div className="flex flex-col gap-space-3">
          {page.hidden ? (
            <SpoilerCover
              hidden
              title={`Round ${through?.round ?? ""} — standings are in`}
              body="This table includes a session you haven't marked as watched."
              onReveal={() => show(page.hiddenSessionIds)}
              onMarkWatched={() => void onMarkWatched()}
            />
          ) : !through ? (
            <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
              {league.range
                ? "The table shows here after the first race in this league's rounds."
                : "The table shows here after the first race."}
            </p>
          ) : (
            <>
              {page.status === "provisional" ? (
                <p className="m-0 text-[14px] text-ink-muted">
                  {`Provisional until round ${through.round}'s results are final.`}
                </p>
              ) : null}
              {current.changed ? (
                <p role="status" className="m-0 text-[16px] font-semibold">
                  {"The table changed. Here's the new one."}
                </p>
              ) : null}
              <StandingsList rows={rows} />
              <StandingsTable rows={rows} />
              {next !== null ? (
                <Button
                  variant="secondary"
                  block
                  disabled={loading}
                  onClick={() => void seeMore()}
                >
                  {loading ? "Loading…" : "See more"}
                </Button>
              ) : null}
              {failed ? (
                <p
                  role="alert"
                  className="m-0 text-[16px] font-semibold text-fall"
                >
                  {"That didn't load. Try again."}
                </p>
              ) : null}
            </>
          )}
          <p className="m-0 text-[14px] leading-[20px] text-ink-muted">
            {page.tiebreak}
          </p>
        </div>
        {!page.hidden && page.yours.length > 0 ? (
          <div className="flex flex-col gap-space-2">
            {page.yours.map((row) => (
              <YourPlace
                key={row.teamId}
                row={row}
                rows={rows}
                through={through}
              />
            ))}
          </div>
        ) : null}
      </div>
      {canLeave ? (
        <LeaveLeague league={league} leave={leave} onLeft={onLeft} />
      ) : null}
    </div>
  );
}
