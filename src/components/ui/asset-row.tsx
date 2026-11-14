import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { teamTintCss } from "@/design/team-ink";
import { formatDelta } from "@/lib/money";
import { useHydrated } from "@/lib/use-hydrated";
import { Badge, type BadgeProps } from "./badge";
import { TeamBadge } from "./team-badge";

type AssetRowProps = {
  /** Team code for the badge. */
  code?: string;
  teamColor?: string;
  /** Driver surname or constructor name, shown in capitals. */
  title: string;
  /** Team name or other secondary line. */
  subtitle?: string;
  /** The one main number, display-ready: "$26.6M" or "38 pts". */
  figure?: string;
  /** Price change in $M: positive shows ▲ in rise, negative ▼ in fall. */
  delta?: number;
  /** A short second figure, e.g. "38 pts". */
  secondary?: string;
  /** At most two are shown. */
  badges?: { tone: BadgeProps["tone"]; label: string }[];
  /** Bold team tint (default true). */
  tinted?: boolean;
  onClick?: () => void;
  href?: string;
  /** Untinted and `aria-disabled`, e.g. for a driver over budget. */
  disabled?: boolean;
  className?: string;
};

/** The grey used for a badge when a row has a code but no team color. */
const NO_TEAM_COLOR = "#7a7aae";

function Delta({ value }: { value: number }) {
  const units = Math.round(value * 10);
  const tone =
    units > 0 ? "text-rise" : units < 0 ? "text-fall" : "text-ink-muted";
  return <span className={tone}>{formatDelta(units)}</span>;
}

/** One driver or constructor in a list: badge, name and one main number. */
function AssetRow({
  code,
  teamColor,
  title,
  subtitle,
  figure,
  delta,
  secondary,
  badges,
  tinted = true,
  onClick,
  href,
  disabled = false,
  className,
}: AssetRowProps) {
  const hydrated = useHydrated();
  const tint = tinted && !disabled && teamColor ? teamColor : undefined;
  const hasSub = delta !== undefined || secondary !== undefined;
  const content: ReactNode = (
    <>
      {code ? (
        <TeamBadge
          code={code}
          color={teamColor ?? NO_TEAM_COLOR}
          teamName={subtitle}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-[6px] font-sans text-[16px] leading-[20px] font-bold tracking-[0.02em] uppercase">
          <span className="truncate">{title}</span>
          {(badges ?? []).slice(0, 2).map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </span>
        {subtitle ? (
          <span className="font-sans text-[14px] leading-[18px] font-medium text-ink-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
      {figure || hasSub ? (
        <span className="flex flex-col items-end font-numeric tabular-nums">
          {figure ? (
            <span className="text-[18px] leading-[22px] font-bold">
              {figure}
            </span>
          ) : null}
          {hasSub ? (
            <span className="text-[16px] leading-[20px] font-semibold whitespace-nowrap text-ink-muted">
              {delta !== undefined ? <Delta value={delta} /> : null}
              {delta !== undefined && secondary ? " · " : null}
              {secondary}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const classes = cn(
    "flex min-h-[56px] w-full items-center gap-space-3 rounded-radius-m border-0 py-[6px] pr-space-3 pl-[6px] text-left font-sans text-ink no-underline",
    !tint && "bg-surface-raised",
    (onClick || href) &&
      "cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
    disabled && "cursor-not-allowed opacity-60",
    className,
  );
  const style = tint ? { backgroundColor: teamTintCss(tint) } : undefined;

  // A disabled link has nowhere to go, so it's a plain row.
  if (href && !disabled) {
    return (
      <a href={href} data-slot="asset-row" className={classes} style={style}>
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        data-slot="asset-row"
        className={classes}
        style={style}
        // aria-disabled, not disabled, so the row stays focusable and is read
        // out ("dimmed") rather than skipped.
        aria-disabled={disabled || undefined}
        disabled={!hydrated}
        onClick={disabled ? undefined : onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      data-slot="asset-row"
      aria-disabled={disabled || undefined}
      className={classes}
      style={style}
    >
      {content}
    </div>
  );
}

export { AssetRow };
export type { AssetRowProps };
