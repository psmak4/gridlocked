import { useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { Button } from "@/components/ui/button";
import { PointsPill } from "@/components/ui/points-pill";
import { Sheet } from "@/components/ui/sheet";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import type { LineupPick } from "@/game/lineups";
import type { MoneyUnits } from "@/lib/money";
import type { LockedView, PoolRow } from "@/play/builder";
import { DriverPicker } from "./driver-picker";

type LockedScoresProps = {
  view: LockedView;
  /** "Show it": this session, on this page only. */
  onShow: (sessionId: string) => void;
  /** "Mark as watched": stored, so every page shows it. */
  onMarkWatched: (sessionId: string) => void;
};

/**
 * The locked team's scores (wave 2 "Locked, with qualifying scores
 * hidden"): one row per scored session, each in a SpoilerCover until it is
 * revealed, and the weekend's total once every one is. The server sends no
 * figure for a hidden session, so there is nothing here to leak.
 */
export function LockedScores({
  view,
  onShow,
  onMarkWatched,
}: LockedScoresProps) {
  const scored = view.sessions.filter((s) => s.scored);
  if (scored.length === 0) {
    return (
      <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
        Your points show here after each session.
      </p>
    );
  }
  const status = view.status ?? "provisional";
  return (
    <section aria-label="Scores" className="flex flex-col gap-space-2">
      {scored.map((s) => {
        const name = s.label.toLowerCase();
        return (
          <SpoilerCover
            key={s.id}
            hidden={!s.revealed}
            title={`${s.label} — scores are in`}
            body={`Your points from ${name} are ready. You haven't marked ${name} as watched.`}
            onReveal={() => onShow(s.id)}
            onMarkWatched={() => onMarkWatched(s.id)}
          >
            <div className="flex items-center justify-between px-[4px] py-space-2">
              <span className="font-display text-[18px] leading-[22px] uppercase">
                {s.label}
              </span>
              <PointsPill points={s.points ?? 0} status={status} />
            </div>
          </SpoilerCover>
        );
      })}
      {view.total !== null && scored.length > 1 ? (
        <div className="flex items-center justify-between border-t border-line px-[4px] pt-space-2">
          <span className="font-display text-[18px] leading-[22px] uppercase">
            This weekend
          </span>
          <PointsPill points={view.total} status={status} />
        </div>
      ) : null}
    </section>
  );
}

type LateCallFlowProps = {
  open: boolean;
  onClose: () => void;
  /** The locked lineup. */
  picks: LineupPick[];
  pool: PoolRow[];
  purchasingPower: MoneyUnits;
  /** Plays Late Call with its one swap; the screen says how it went. */
  onPlay: (outAssetId: string, inAssetId: string) => Promise<void>;
};

/**
 * "Play Late Call · swap one driver": who goes out, who comes in (the
 * driver picker, within the race's budget), then a confirm step, since a
 * chip has no undo. The new driver scores from the race on.
 */
export function LateCallFlow({
  open,
  onClose,
  picks,
  pool,
  purchasingPower,
  onPlay,
}: LateCallFlowProps) {
  const [out, setOut] = useState<PoolRow | null>(null);
  const [into, setInto] = useState<PoolRow | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const rows = new Map(pool.map((row) => [row.assetId, row]));
  const spent = picks.reduce(
    (sum, p) => sum + (rows.get(p.assetId)?.price ?? 0),
    0,
  );
  const close = () => {
    setOut(null);
    setInto(null);
    onClose();
  };

  if (out && into) {
    return (
      <Sheet
        open
        onClose={close}
        title="Play Late Call?"
        actions={
          <Button
            size="l"
            block
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onPlay(out.assetId, into.assetId).finally(() => {
                setBusy(false);
                close();
              });
            }}
          >
            {busy ? "Playing…" : "Play Late Call"}
          </Button>
        }
      >
        <div className="flex flex-col gap-space-2 text-[16px] leading-[22px]">
          <p className="m-0">
            Swap <strong>{out.title}</strong> for <strong>{into.title}</strong>.{" "}
            {into.title} scores from the race on.
          </p>
          <p className="m-0 font-bold">{"You can't undo this."}</p>
        </div>
      </Sheet>
    );
  }

  if (out) {
    const pick = picks.find((p) => p.assetId === out.assetId);
    return (
      <DriverPicker
        open
        onClose={close}
        kind={out.kind}
        replacing={{ row: out, isBoost: pick?.isBoost ?? false }}
        pool={pool}
        picked={new Set(picks.map((p) => p.assetId))}
        budget={purchasingPower - spent + out.price}
        limitless={false}
        transferLine={null}
        onPick={(assetId) => setInto(rows.get(assetId) ?? null)}
      />
    );
  }

  const drivers = picks
    .map((p) => ({ pick: p, row: rows.get(p.assetId) }))
    .filter(
      (p): p is { pick: LineupPick; row: PoolRow } => p.row?.kind === "driver",
    );
  return (
    <Sheet open onClose={close} title="Late Call">
      <p className="m-0 text-[16px] leading-[22px]">
        Pick the driver to swap out. The new one scores from the race on.
      </p>
      <ul
        aria-label="Your drivers"
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {drivers.map(({ pick, row }) => (
          <li key={row.assetId}>
            <AssetRow
              code={row.code}
              teamColor={row.color}
              title={row.title}
              subtitle={row.subtitle}
              badges={pick.isBoost ? [{ tone: "boost", label: "2×" }] : []}
              onClick={() => setOut(row)}
            />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
