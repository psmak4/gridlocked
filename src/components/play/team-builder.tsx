import { useEffect, useMemo, useRef, useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { BudgetMeter } from "@/components/ui/budget-meter";
import { Button } from "@/components/ui/button";
import { CountdownBlock } from "@/components/ui/countdown-block";
import { Toast } from "@/components/ui/toast";
import type { GameErrorCode } from "@/game/errors";
import type { LineupPick } from "@/game/lineups";
import { systemTimer } from "@/lib/clock";
import { formatMoney } from "@/lib/money";
import { useHydrated } from "@/lib/use-hydrated";
import type { BuilderPage, PoolRow, SaveTeamResult } from "@/play/builder";
import { previewTeam } from "@/play/preview";
import { availabilityBadge, DriverPicker, rowFigures } from "./driver-picker";
import {
  countdownTick,
  inactiveWords,
  lockCountdown,
  overCapWords,
  penaltyWords,
  problemWords,
  teamWords,
  transferNote,
  transferStat,
} from "./team-words";
import { samePicks, useDraft } from "./use-draft";

type SaveInput = {
  teamId: string;
  eventId: string;
  picks: LineupPick[];
  basedOnVersionId: string | null;
};

type TeamBuilderProps = {
  page: BuilderPage;
  save: (input: SaveInput) => Promise<SaveTeamResult>;
  /** Reads the page again (the route loader). */
  reload: () => Promise<void>;
};

/**
 * The milliseconds left to `lockAt` on the server's clock: the page's `now`
 * at first (so the server and the first client render agree), then ticking
 * in the browser by the same offset: real time passing (`systemTimer`) on
 * the server's "now", which a replay sets.
 */
function useTimeLeft(lockAt: string | null, serverNow: string): number | null {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    if (!lockAt) return;
    const offset = Date.parse(serverNow) - systemTimer.now();
    const lock = Date.parse(lockAt);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = systemTimer.now() + offset;
      setNow(at);
      timer = setTimeout(tick, countdownTick(lock - at));
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [lockAt, serverNow]);
  return lockAt ? Date.parse(lockAt) - now : null;
}

const sectionTitle =
  "m-0 font-display text-[18px] leading-[22px] font-normal tracking-[0.02em]";

type Slot = { kind: "driver" | "constructor"; pick: LineupPick | null };

/** An empty slot: a dashed row that opens the picker. */
function EmptySlot({
  kind,
  onClick,
  disabled,
}: {
  kind: "driver" | "constructor";
  onClick: () => void;
  disabled: boolean;
}) {
  const hydrated = useHydrated();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !hydrated}
      className="flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-radius-m border-2 border-dashed border-line-strong bg-transparent font-sans text-[16px] font-bold text-ink-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed"
    >
      Add a {kind}
    </button>
  );
}

/**
 * The team builder (wave 2: "Ready to save", "Over the cap with an extra
 * transfer"): the countdown, the budget, 5 driver and 2 constructor rows,
 * and Save in a bar fixed above the nav. Picks are kept as a draft in the
 * browser until saved. The preview is the friendlier early answer; the
 * save's refusal, in words, is the final one.
 */
export function TeamBuilder({ page, save, reload }: TeamBuilderProps) {
  const { state, timeZone } = page;
  const { team, event } = state;
  const open = state.phase === "open" && event !== null;
  const saved = state.latest?.picks ?? state.base ?? null;
  const draft = useDraft(team.id, event?.id ?? "none", saved);
  // Locked or between: the team as saved, never the draft (which stays).
  const picks = useMemo(
    () => (open ? draft.picks : (state.latest?.picks ?? [])),
    [open, draft.picks, state.latest],
  );

  const preview = useMemo(() => previewTeam(state, picks), [state, picks]);
  const rows = useMemo(
    () => new Map(state.pool.map((row) => [row.assetId, row])),
    [state.pool],
  );
  const left = useTimeLeft(open ? event.lockAt : null, page.now);

  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    text: string;
    theirs: LineupPick[] | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<{
    kind: "driver" | "constructor";
    replacing: string | null;
  } | null>(null);
  const reloadedAtLock = useRef(false);

  // At the lock, read the page again: the server says it's locked.
  useEffect(() => {
    if (left !== null && left <= 0 && !reloadedAtLock.current) {
      reloadedAtLock.current = true;
      void reload();
    }
  }, [left, reload]);

  const pickedRows = picks
    .map((pick) => ({ pick, row: rows.get(pick.assetId) }))
    .filter((p): p is { pick: LineupPick; row: PoolRow } => !!p.row);
  const slots = (kind: "driver" | "constructor", size: number): Slot[] => {
    const filled: Slot[] = pickedRows
      .filter(({ row }) => row.kind === kind)
      .map(({ pick }) => ({ kind, pick }));
    while (filled.length < size) filled.push({ kind, pick: null });
    return filled;
  };
  const driverSlots = slots("driver", state.squad.drivers);
  const constructorSlots = slots("constructor", state.squad.constructors);
  const counts = {
    drivers: pickedRows.filter(({ row }) => row.kind === "driver").length,
    constructors: pickedRows.filter(({ row }) => row.kind === "constructor")
      .length,
    squad: state.squad,
  };

  const changed = !samePicks(picks, saved ?? []);
  const problem =
    preview.overBy > 0 ? null : problemWords(preview.problems, counts);
  const canSave = open && !saving && changed && preview.problems.length === 0;

  const setPicks = (next: LineupPick[]) => {
    setMessage(null);
    draft.setPicks(next);
  };

  async function onSave() {
    if (!canSave || !event) return;
    setSaving(true);
    setMessage(null);
    const words = (error: GameErrorCode | "server_error") =>
      teamWords(error, { lockAt: event.lockAt, timeZone });
    try {
      const result = await save({
        teamId: team.id,
        eventId: event.id,
        picks,
        basedOnVersionId: state.basedOnVersionId,
      });
      if (!result.ok) {
        setMessage(words(result.error));
        // The prices, the pool or the phase may have moved: read them
        // again. The draft stays.
        await reload();
        return;
      }
      await reload();
      draft.clear();
      setToast(
        result.staleBase
          ? { text: "Your other device saved changes", theirs: result.theirs }
          : { text: "Team saved", theirs: null },
      );
    } catch {
      setMessage(words("server_error"));
    } finally {
      setSaving(false);
    }
  }

  // --- The picker --------------------------------------------------------------
  const replacing = picker?.replacing
    ? picks.find((p) => p.assetId === picker.replacing)
    : undefined;
  const replacingRow = replacing ? rows.get(replacing.assetId) : undefined;
  const slotBudget =
    state.purchasingPower - preview.spent + (replacingRow?.price ?? 0);
  const transferLine = (() => {
    if (!picker || preview.free === null) return null;
    const adds = replacingRow ? (replacingRow.inBase ? 1 : 0) : 1;
    if (adds === 0 || state.base === null) return null;
    const n = preview.transfers + adds;
    if (n > preview.free) {
      return `This change costs ${Math.abs(state.penaltyPerTransfer)} points.`;
    }
    const nth = ["1st", "2nd", "3rd"][n - 1] ?? `${n}th`;
    return `This will be your ${nth} of ${preview.free} free transfers.`;
  })();

  const choose = (assetId: string) => {
    if (!picker) return;
    if (replacing) {
      setPicks(
        picks.map((p) =>
          p.assetId === replacing.assetId ? { ...p, assetId } : p,
        ),
      );
    } else {
      setPicks([...picks, { assetId, isBoost: false }]);
    }
    setPicker(null);
  };
  const boost = (on: boolean) => {
    if (!replacing) return;
    setPicks(
      picks.map((p) => ({
        ...p,
        isBoost: p.assetId === replacing.assetId ? on : on ? false : p.isBoost,
      })),
    );
  };
  const remove = () => {
    if (!replacing) return;
    setPicks(picks.filter((p) => p.assetId !== replacing.assetId));
    setPicker(null);
  };

  // --- The rows ----------------------------------------------------------------
  const pickRow = (slot: Slot, index: number) => {
    if (!slot.pick) {
      return (
        <li key={`empty-${slot.kind}-${index}`}>
          <EmptySlot
            kind={slot.kind}
            disabled={!open}
            onClick={() => setPicker({ kind: slot.kind, replacing: null })}
          />
        </li>
      );
    }
    const pick = slot.pick;
    const row = rows.get(pick.assetId)!;
    const badges: { tone: "boost" | "caution" | "neutral"; label: string }[] =
      [];
    if (pick.isBoost) badges.push({ tone: "boost", label: "2×" });
    const inactive = availabilityBadge(row);
    if (inactive) badges.push(inactive);
    if (open && state.base !== null && !row.inBase) {
      badges.push({ tone: "neutral", label: "New" });
    }
    return (
      <li key={pick.assetId} data-asset-id={pick.assetId}>
        <AssetRow
          code={row.code}
          teamColor={row.color}
          title={row.title}
          subtitle={row.subtitle}
          {...rowFigures(row)}
          badges={badges}
          onClick={
            open
              ? () => setPicker({ kind: row.kind, replacing: pick.assetId })
              : undefined
          }
        />
      </li>
    );
  };

  const bank = Math.max(0, state.purchasingPower - preview.spent);
  const inactive = open
    ? inactiveWords(pickedRows.map(({ row }) => row))
    : null;
  const penalty = open ? penaltyWords(preview) : null;

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-[96px] lg:pb-[96px]">
      <div className="flex flex-col gap-[2px]">
        {event ? (
          <span className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase">
            Round {event.round} · {event.name}
          </span>
        ) : null}
        <h1 className="m-0 font-display text-[32px] leading-[34px] font-normal break-words uppercase">
          {team.name}
        </h1>
        <a
          href="/team?list=1"
          className="inline-flex min-h-[44px] items-center self-start text-[16px] font-bold text-heat-text underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          Your teams
        </a>
      </div>

      {open ? (
        <CountdownBlock
          label="Locks in"
          value={lockCountdown(left ?? 0)}
          stats={[
            {
              value: state.limitless ? "No cap" : formatMoney(bank),
              label: "Bank",
            },
            { value: transferStat(preview), label: "Transfers" },
          ]}
        />
      ) : (
        <CountdownBlock
          label={state.phase === "locked" ? "Your team" : "Next race"}
          value={state.phase === "locked" ? "LOCKED" : "SOON"}
        />
      )}

      {message ? (
        <p
          role="alert"
          className="m-0 rounded-radius-m bg-surface-raised p-space-3 text-[16px] leading-[22px] font-semibold"
        >
          {message}
        </p>
      ) : null}

      {open && !state.limitless ? (
        <BudgetMeter
          spent={preview.spent / 10}
          cap={state.purchasingPower / 10}
        />
      ) : null}
      {open && state.limitless ? (
        <p className="m-0 text-[16px] font-semibold">
          Blank Cheque: no cap this race.
        </p>
      ) : null}

      {open && (preview.overBy > 0 || penalty) ? (
        <div className="flex flex-col gap-[6px] rounded-radius-m bg-surface-raised p-space-3">
          {preview.overBy > 0 ? (
            <span className="text-[16px] leading-[22px] font-semibold">
              {overCapWords(preview.overBy)}
            </span>
          ) : null}
          {penalty ? (
            <span className="text-[14px] leading-[20px] text-ink-muted">
              {penalty}
            </span>
          ) : null}
        </div>
      ) : null}

      {open && problem ? (
        <p className="m-0 text-[16px] leading-[22px]">{problem}</p>
      ) : null}
      {inactive ? (
        <p className="m-0 text-[16px] leading-[22px] font-semibold text-caution">
          {inactive}
        </p>
      ) : null}
      {state.phase === "between" ? (
        <p className="m-0 text-[16px] leading-[22px]">
          The next race opens for picks once this one is final.
        </p>
      ) : null}

      <section
        aria-labelledby="drivers-title"
        className="flex flex-col gap-space-2"
      >
        <div className="flex items-baseline justify-between gap-space-2">
          <h2 id="drivers-title" className={sectionTitle}>
            DRIVERS
          </h2>
          <span className="text-[14px] font-medium text-ink-muted">
            {open ? transferNote(preview) : "Locked until after the race"}
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
          {driverSlots.map(pickRow)}
        </ul>
      </section>

      <section
        aria-labelledby="constructors-title"
        className="flex flex-col gap-space-2"
      >
        <h2 id="constructors-title" className={sectionTitle}>
          CONSTRUCTORS
        </h2>
        <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
          {constructorSlots.map(pickRow)}
        </ul>
      </section>

      {open ? (
        <div className="fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-10 flex flex-col gap-space-2 border-t border-line bg-surface px-space-4 py-[10px] lg:bottom-0 lg:left-[240px]">
          {toast ? (
            <Toast
              key={toast.text}
              actionLabel={toast.theirs ? "See their team" : undefined}
              onAction={() => {
                if (toast.theirs) setPicks(toast.theirs);
                setToast(null);
              }}
              onDismiss={() => setToast(null)}
            >
              {toast.text}
            </Toast>
          ) : null}
          <div className="mx-auto flex w-full max-w-[1200px] gap-[10px]">
            <Button
              size="l"
              block
              disabled={!canSave}
              onClick={() => void onSave()}
            >
              {saving ? "Saving…" : "Save team"}
            </Button>
          </div>
        </div>
      ) : null}

      {picker ? (
        <DriverPicker
          open
          onClose={() => setPicker(null)}
          kind={picker.kind}
          replacing={
            replacing && replacingRow
              ? { row: replacingRow, isBoost: replacing.isBoost }
              : null
          }
          pool={state.pool}
          picked={new Set(picks.map((p) => p.assetId))}
          budget={slotBudget}
          limitless={state.limitless}
          transferLine={transferLine}
          onPick={choose}
          onBoost={boost}
          onRemove={remove}
        />
      ) : null}
    </div>
  );
}
