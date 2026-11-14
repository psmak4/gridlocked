import { cn } from "@/lib/utils";
import { teamInk } from "@/design/team-ink";

type TeamBadgeProps = {
  /** Three-letter code, e.g. "MCL". */
  code: string;
  /** The constructor's season color, `#rrggbb`. */
  color: string;
  /** Shown as the tooltip, e.g. "McLaren". */
  teamName?: string;
  variant?: "solid" | "outline";
  size?: "m" | "s";
  className?: string;
};

/** A team's block with its code: the only team mark the product uses. */
function TeamBadge({
  code,
  color,
  teamName,
  variant = "solid",
  size = "m",
  className,
}: TeamBadgeProps) {
  const outline = variant === "outline";
  return (
    <span
      data-slot="team-badge"
      title={teamName}
      style={
        outline
          ? { borderColor: color }
          : { backgroundColor: color, color: teamInk(color) }
      }
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-display tracking-[0.02em]",
        size === "s"
          ? "h-[28px] w-[38px] rounded-radius-s text-[13px]"
          : "size-[46px] rounded-radius-m text-[15px]",
        outline && "border-[3px] bg-surface text-ink",
        className,
      )}
    >
      {code}
    </span>
  );
}

export { TeamBadge };
export type { TeamBadgeProps };
