import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  /** What's missing, e.g. "No leagues yet". */
  title: string;
  /** One sentence on what will appear and why it's empty. */
  body?: string;
  /** At most one action, usually a primary Button. */
  action?: ReactNode;
  /** The title's heading level, to fit the page's outline. Default 2. */
  headingLevel?: 1 | 2 | 3;
  className?: string;
};

/** What a screen shows when it has nothing yet. A state, not an error. */
function EmptyState({
  title,
  body,
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-space-3 px-space-4 py-space-6 text-center text-ink",
        className,
      )}
    >
      <Heading className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase">
        {title}
      </Heading>
      {body ? (
        <p className="m-0 max-w-[32ch] font-sans text-[16px] leading-[24px] text-ink-muted">
          {body}
        </p>
      ) : null}
      {action ?? null}
    </div>
  );
}

export { EmptyState };
export type { EmptyStateProps };
