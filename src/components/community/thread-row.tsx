import type { ThreadBadge, ThreadRow } from "@/community/read";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { threadMeta } from "./forum-words";

const BADGE_WORDS: Record<ThreadBadge, string> = {
  pinned: "Pinned",
  session: "Session",
  spoiler: "Spoiler",
};

/**
 * One thread in a category (wave 4): its badge, title, who and when, and
 * its score. A hidden thread shows its spoiler-safe title on the veil, and
 * what it waits for.
 */
export function ThreadRowItem({
  row,
  nowMs,
}: {
  row: ThreadRow;
  nowMs: number;
}) {
  return (
    <li>
      <a
        href={`/t/${row.id}`}
        data-hidden={row.hidden || undefined}
        className={cn(
          "flex min-h-[64px] items-start gap-space-3 rounded-radius-m px-[14px] py-space-3 text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          row.hidden ? "bg-veil" : "bg-surface-raised hover:bg-surface-sunken",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
          {row.badge ? (
            <Badge
              tone={row.badge === "pinned" ? "neutral" : "caution"}
              className="self-start"
            >
              {BADGE_WORDS[row.badge]}
            </Badge>
          ) : null}
          <span className="text-[16px] leading-[22px] font-bold break-words">
            {row.title}
          </span>
          {row.hiddenNote ? (
            <span className="text-[14px] leading-[20px] text-ink-muted">
              {row.hiddenNote}
            </span>
          ) : null}
          <span className="text-[14px] leading-[20px] text-ink-muted">
            {threadMeta(row, nowMs)}
          </span>
        </span>
        <span
          className="shrink-0 font-numeric text-[16px] font-bold"
          aria-label={`Score ${row.score}`}
        >
          {row.score}
        </span>
      </a>
    </li>
  );
}
