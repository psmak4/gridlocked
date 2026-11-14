import { cn } from "@/lib/utils";

type PointsPillProps = {
  points: number;
  status?: "provisional" | "final";
  className?: string;
};

/**
 * A score for an event, with the word Provisional or Final. A score gives the
 * result away, so wrap it in a SpoilerCover until the person has watched.
 */
function PointsPill({ points, status = "final", className }: PointsPillProps) {
  return (
    <span
      data-slot="points-pill"
      className={cn(
        "inline-flex items-baseline gap-[6px] rounded-radius-pill border-[1.5px] bg-surface-raised px-space-3 py-space-1 font-numeric text-[18px] leading-[22px] font-bold text-ink tabular-nums",
        status === "provisional"
          ? "border-dashed border-line-strong"
          : "border-transparent",
        className,
      )}
    >
      {`${points} pts`}
      <small className="font-sans text-[12px] tracking-[0.08em] text-ink-muted uppercase">
        {status === "final" ? "Final" : "Provisional"}
      </small>
    </span>
  );
}

export { PointsPill };
export type { PointsPillProps };
