import { useState } from "react";
import { AssetRow, type AssetRowProps } from "@/components/ui/asset-row";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { formatMoney, type MoneyUnits } from "@/lib/money";
import type { PoolRow } from "@/play/builder";

/** How many rows the picker shows before "See all" (wave 2: about 7). */
export const PICKER_ROWS = 7;

/** A pool row's price change and ownership, as AssetRow takes them. */
export function rowFigures(
  row: PoolRow,
): Pick<AssetRowProps, "figure" | "delta" | "secondary"> {
  return {
    figure: formatMoney(row.price),
    delta: row.delta === null ? undefined : row.delta / 10,
    secondary:
      row.ownership === null
        ? undefined
        : `${Math.round(row.ownership * 100)}% picked`,
  };
}

/** "Out this race", "Doubtful" or "Withdrawn", for a row's badges. */
export function availabilityBadge(
  row: PoolRow,
): { tone: "caution"; label: string } | null {
  switch (row.availability) {
    case "out":
      return { tone: "caution", label: "Out this race" };
    case "doubtful":
      return { tone: "caution", label: "Doubtful" };
    case "withdrawn":
      return { tone: "caution", label: "Withdrawn" };
    default:
      return null;
  }
}

/**
 * The window of rows shown before "See all": from one row the team can't
 * afford (so the cap is plain) down through the dearest it can.
 */
export function pickerWindow<T extends { price: number }>(
  rows: T[],
  budget: number,
  size = PICKER_ROWS,
): T[] {
  const affordable = rows.findIndex((row) => row.price <= budget);
  const first = affordable === -1 ? rows.length - size : affordable - 1;
  const start = Math.max(0, Math.min(first, rows.length - size));
  return rows.slice(start, start + size);
}

type DriverPickerProps = {
  open: boolean;
  onClose: () => void;
  kind: "driver" | "constructor";
  /** The pick this replaces, or null to fill an empty slot. */
  replacing: { row: PoolRow; isBoost: boolean } | null;
  pool: PoolRow[];
  /** Every asset in the team now. */
  picked: Set<string>;
  /** What the slot may cost; ignored with `limitless`. */
  budget: MoneyUnits;
  limitless: boolean;
  /** "This will be your 2nd of 2 free transfers.", or null. */
  transferLine: string | null;
  onPick: (assetId: string) => void;
  /** Puts the 2× Boost on the driver being replaced, or takes it off. */
  onBoost?: (on: boolean) => void;
  /** Takes the pick out; left out for a swap that must fill the slot. */
  onRemove?: () => void;
};

/**
 * "Pick a driver" (wave 2): the pool for one slot, dearest first, about 7
 * rows with "See all". What the team can't pick stays visible, untinted and
 * dimmed, saying why.
 */
export function DriverPicker({
  open,
  onClose,
  kind,
  replacing,
  pool,
  picked,
  budget,
  limitless,
  transferLine,
  onPick,
  onBoost,
  onRemove,
}: DriverPickerProps) {
  const [all, setAll] = useState(false);
  const noun = kind === "driver" ? "driver" : "constructor";
  const rows = pool.filter((row) => row.kind === kind);
  const shown = all
    ? rows
    : pickerWindow(rows, limitless ? Number.POSITIVE_INFINITY : budget);

  const close = () => {
    setAll(false);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={`Pick a ${noun}`}>
      <div className="flex flex-col gap-space-1">
        <p className="m-0 text-[16px] leading-[22px]">
          {replacing ? (
            <>
              Replacing <strong>{replacing.row.title}</strong>.{" "}
            </>
          ) : null}
          {limitless ? (
            "No cap this race."
          ) : (
            <>
              You can spend up to <strong>{formatMoney(budget)}</strong>.
            </>
          )}
        </p>
        {transferLine ? (
          <p className="m-0 text-[14px] text-ink-muted">{transferLine}</p>
        ) : null}
      </div>

      {replacing && (onBoost || onRemove) ? (
        <div className="flex flex-col gap-space-2">
          {kind === "driver" && onBoost ? (
            <Switch
              id="boost-switch"
              label="2× Boost"
              description={`${replacing.row.title} scores double points.`}
              checked={replacing.isBoost}
              onChange={onBoost}
            />
          ) : null}
          {onRemove ? (
            <Button variant="quiet" block onClick={onRemove}>
              Remove {replacing.row.title}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-bold tracking-[0.12em] text-ink-muted">
          BY PRICE · HIGH TO LOW
        </span>
        <span className="text-[14px] text-ink-muted">
          {rows.length} {noun}s
        </span>
      </div>

      <ul
        aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)}s`}
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {shown.map((row) => {
          const inTeam = picked.has(row.assetId);
          const over = !limitless && row.price > budget;
          const gone = row.availability === "withdrawn" && !row.inBase;
          const badge = availabilityBadge(row);
          let props: Partial<AssetRowProps>;
          if (inTeam) {
            props = {
              figure: formatMoney(row.price),
              secondary: "Already in your team",
              badges: [{ tone: "neutral", label: "In team" }],
              tinted: false,
              disabled: true,
            };
          } else if (gone) {
            props = {
              figure: formatMoney(row.price),
              secondary: "Can't be picked",
              badges: badge ? [badge] : [],
              tinted: false,
              disabled: true,
            };
          } else if (over) {
            props = {
              figure: formatMoney(row.price),
              secondary: `${formatMoney(row.price - budget)} over budget`,
              tinted: false,
              disabled: true,
            };
          } else {
            props = { ...rowFigures(row), badges: badge ? [badge] : [] };
          }
          return (
            <li key={row.assetId} data-asset-id={row.assetId}>
              <AssetRow
                code={row.code}
                teamColor={row.color}
                title={row.title}
                subtitle={row.subtitle}
                onClick={() => onPick(row.assetId)}
                {...props}
              />
            </li>
          );
        })}
      </ul>
      {!all && shown.length < rows.length ? (
        <Button variant="quiet" block onClick={() => setAll(true)}>
          See all {rows.length} {noun}s
        </Button>
      ) : null}
    </Sheet>
  );
}
