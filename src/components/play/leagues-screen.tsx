import { useId, useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Toast } from "@/components/ui/toast";
import type { LeagueRow, LeaguesPage } from "@/play/leagues";
import { JoinSheet, type JoinResult } from "./join-sheet";
import { leagueSubtitle, moveWords, rankFigure } from "./league-words";

const sectionTitle =
  "m-0 font-display text-[18px] leading-[22px] font-normal tracking-[0.02em] uppercase";

type LeaguesScreenProps = {
  page: LeaguesPage;
  join: (data: { code: string; teamId: string }) => Promise<JoinResult>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

/** A league's code, to share, with Copy. */
export function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex items-center justify-between gap-space-3 rounded-radius-m bg-surface px-[14px] py-space-3"
    >
      <span className="flex flex-col">
        <span
          id={labelId}
          className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase"
        >
          Invite with code
        </span>
        <span
          data-join-code
          className="font-numeric text-[22px] font-bold tracking-[0.08em]"
        >
          {code}
        </span>
      </span>
      <Button
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * My leagues (wave 3): Join with a code and Create a league, then yours and
 * the automatic ones, each a link to its standings. A rank is covered while
 * its table's latest event is hidden from you (M6 decision 2).
 */
export function LeaguesScreen({ page, join, reload }: LeaguesScreenProps) {
  const [joining, setJoining] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { yours, automatic } = page.leagues;
  const many = page.teams.length > 1;

  if (page.teams.length === 0) {
    return (
      <div className="px-space-4 pt-space-4">
        <EmptyState
          headingLevel={1}
          title="No leagues yet"
          body="Your team joins leagues. Build one first, then join or create a league."
          action={
            <Button staticLink href="/team">
              Build your team
            </Button>
          }
        />
      </div>
    );
  }

  const row = (league: LeagueRow) => (
    <li key={`${league.leagueId}:${league.teamId}`}>
      <AssetRow
        title={league.name}
        subtitle={leagueSubtitle(league, many)}
        figure={rankFigure(league)}
        secondary={moveWords(league.move)}
        tinted={false}
        href={`/leagues/${league.slug}`}
      />
    </li>
  );

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6">
      <div className="flex flex-col gap-[2px]">
        {!many ? (
          <span className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase">
            {page.teams[0]!.name}
          </span>
        ) : null}
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal uppercase">
          Leagues
        </h1>
      </div>

      <div className="grid grid-cols-2 gap-space-2">
        <Button variant="secondary" onClick={() => setJoining(true)}>
          Join with a code
        </Button>
        <Button variant="quiet" staticLink href="/leagues/new">
          Create a league
        </Button>
      </div>

      <h2 className={`${sectionTitle} mt-[4px]`}>Your leagues</h2>
      {yours.length === 0 ? (
        <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
          {
            "You're not in any leagues yet. Join one with a code, or create your own."
          }
        </p>
      ) : (
        <ul
          aria-label="Your leagues"
          className="m-0 flex list-none flex-col gap-space-2 p-0"
        >
          {yours.map((league) => row(league))}
        </ul>
      )}

      <div className="mt-[4px] flex flex-col gap-[2px]">
        <h2 className={sectionTitle}>Automatic</h2>
        <span className="text-[14px] text-ink-muted">
          {
            "You're in these from your profile. Change your favorites to switch."
          }
        </span>
      </div>
      <ul
        aria-label="Automatic leagues"
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {automatic.map((league) => row(league))}
      </ul>

      <JoinSheet
        open={joining}
        onClose={() => setJoining(false)}
        teams={page.teams}
        join={join}
        onJoined={async (name) => {
          setJoining(false);
          await reload();
          setToast(`You joined ${name}.`);
        }}
      />
      {toast ? (
        <div className="fixed inset-x-space-4 bottom-[88px] z-40 lg:bottom-space-4">
          <Toast onDismiss={() => setToast(null)}>{toast}</Toast>
        </div>
      ) : null}
    </div>
  );
}
