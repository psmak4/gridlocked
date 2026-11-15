import { useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useHydrated } from "@/lib/use-hydrated";
import type { ChipState, PoolRow } from "@/play/builder";
import { chipRow } from "./team-words";

type Step =
  | { kind: "list" }
  | { kind: "target"; chip: ChipState }
  | { kind: "confirm"; chip: ChipState; target: PoolRow | null };

type ChipSheetProps = {
  open: boolean;
  onClose: () => void;
  chips: ChipState[];
  /**
   * Overdrive's choices: the drivers of the saved team, with which has the
   * Boost. Empty when there is no saved team or the screen has unsaved
   * changes, since the chip goes on the team as saved.
   */
  drivers: { row: PoolRow; isBoost: boolean }[];
  /** Plays a chip: resolves to the refusal's words, or null once played. */
  onPlay: (
    code: string,
    targetAssetId: string | null,
  ) => Promise<string | null>;
};

/**
 * The chip sheet (wave 2 "Chips sheet"): one row per chip with its sentence,
 * and one "Play <name>" at a time behind a confirm step, because a chip has
 * no undo (DM 3.9). Overdrive asks for its driver first, never the Boost one.
 */
export function ChipSheet({
  open,
  onClose,
  chips,
  drivers,
  onPlay,
}: ChipSheetProps) {
  const hydrated = useHydrated();
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const anotherPlayed = chips.some((c) => c.status === "played");

  const close = () => {
    setStep({ kind: "list" });
    setError(null);
    onClose();
  };

  async function play(chip: ChipState, target: PoolRow | null) {
    setBusy(true);
    try {
      const words = await onPlay(chip.code, target?.assetId ?? null);
      if (words === null) {
        close();
        return;
      }
      setError(words);
      setStep({ kind: "list" });
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "target") {
    return (
      <Sheet open={open} onClose={close} title={step.chip.name}>
        <p className="m-0 text-[16px] leading-[22px]">
          {
            "Pick the driver who scores 3× this weekend. Your 2× Boost driver can't take it."
          }
        </p>
        <ul
          aria-label="Your drivers"
          className="m-0 flex list-none flex-col gap-space-2 p-0"
        >
          {drivers.map(({ row, isBoost }) => (
            <li key={row.assetId}>
              <AssetRow
                code={row.code}
                teamColor={row.color}
                title={row.title}
                subtitle={row.subtitle}
                secondary={isBoost ? "Has your 2× Boost" : undefined}
                badges={isBoost ? [{ tone: "boost", label: "2×" }] : []}
                tinted={!isBoost}
                disabled={isBoost}
                onClick={() =>
                  setStep({ kind: "confirm", chip: step.chip, target: row })
                }
              />
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  if (step.kind === "confirm") {
    const { chip, target } = step;
    return (
      <Sheet
        open={open}
        onClose={close}
        title={`Play ${chip.name}?`}
        actions={
          <Button
            size="l"
            block
            disabled={busy}
            onClick={() => void play(chip, target)}
          >
            {busy ? "Playing…" : `Play ${chip.name}`}
          </Button>
        }
      >
        <div className="flex flex-col gap-space-2 text-[16px] leading-[22px]">
          <p className="m-0">{chip.sentence}</p>
          {target ? (
            <p className="m-0">
              On <strong>{target.title}</strong>.
            </p>
          ) : null}
          <p className="m-0 font-bold">{"You can't undo this."}</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={close} title="Play a chip">
      <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
        {
          "Each chip works once a season, one per race. You can't undo a chip once it's played."
        }
      </p>
      {error ? (
        <p
          role="alert"
          className="m-0 rounded-radius-m bg-surface p-space-3 text-[16px] leading-[22px] font-semibold"
        >
          {error}
        </p>
      ) : null}
      <ul
        aria-label="Chips"
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {chips.map((chip) => {
          const { label, playable } = chipRow(chip, {
            anotherPlayed,
            overdriveReady: drivers.length > 0,
          });
          return (
            <li key={chip.code}>
              <button
                type="button"
                disabled={!playable || !hydrated}
                onClick={() => {
                  setError(null);
                  setStep(
                    chip.effect === "triple_boost"
                      ? { kind: "target", chip }
                      : { kind: "confirm", chip, target: null },
                  );
                }}
                className="flex min-h-[64px] w-full cursor-pointer items-center justify-between gap-space-3 rounded-radius-m border-0 bg-surface px-[14px] py-[10px] text-left font-sans text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed"
              >
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="text-[16px] leading-[22px] font-bold">
                    {chip.name}
                  </span>
                  <span className="text-[14px] leading-[20px] text-ink-muted">
                    {chip.sentence}
                  </span>
                </span>
                <span
                  className={
                    playable
                      ? "shrink-0 text-[14px] font-bold text-heat-text"
                      : "shrink-0 text-right text-[14px] font-bold text-ink-muted"
                  }
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
