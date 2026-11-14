import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type SpoilerCoverProps = {
  /** True until the session is watched or revealed. The children aren't rendered while true. */
  hidden: boolean;
  /** Neutral copy: "Race — results are in", never a name or a position. */
  title?: string;
  body?: string;
  /** "Show it": reveals just this item. */
  onReveal?: () => void;
  /** "Mark as watched": shown only when given. */
  onMarkWatched?: () => void;
  children?: ReactNode;
  className?: string;
};

/**
 * The placeholder shown instead of anything that would reveal a session's
 * result. While hidden, the children are not rendered at all, so they can't
 * leak through zoom, copy or a screen reader.
 */
function SpoilerCover({
  hidden,
  title = "Spoiler protected",
  body = "You haven’t marked this session as watched.",
  onReveal,
  onMarkWatched,
  children,
  className,
}: SpoilerCoverProps) {
  if (!hidden) return <>{children}</>;
  return (
    <div
      data-slot="spoiler-cover"
      className={cn(
        "flex flex-col items-start gap-space-3 rounded-radius-m bg-veil p-space-4 text-ink",
        className,
      )}
    >
      <p className="m-0 font-display text-[18px] leading-[22px] tracking-[0.02em] uppercase">
        {title}
      </p>
      <p className="m-0 font-sans text-[16px] leading-[22px] text-ink-muted">
        {body}
      </p>
      <div className="flex flex-wrap gap-space-2">
        <Button variant="secondary" onClick={onReveal}>
          Show it
        </Button>
        {onMarkWatched ? (
          <Button variant="quiet" onClick={onMarkWatched}>
            Mark as watched
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export { SpoilerCover };
export type { SpoilerCoverProps };
