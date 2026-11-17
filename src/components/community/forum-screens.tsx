import type { ReactNode } from "react";
import type { CategoryView } from "@/community/read";

export const eyebrow =
  "text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";
export const backLink =
  "flex min-h-[44px] items-center self-start text-[16px] font-bold text-ink-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
export const pageTitle =
  "m-0 font-display text-[32px] leading-[34px] font-normal uppercase break-words";

/** A forum screen's column. */
export function ForumPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6">
      {children}
    </div>
  );
}

/** One category on the forum's front page: name, what it's for, today's posts. */
export function CategoryRow({ category }: { category: CategoryView }) {
  return (
    <li>
      <a
        href={`/forum/${category.slug}`}
        className="flex min-h-[64px] items-center gap-space-3 rounded-radius-m bg-surface-raised px-[14px] py-space-3 text-ink no-underline outline-none hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="font-display text-[18px] leading-[22px] tracking-[0.02em] uppercase">
            {category.name}
          </span>
          <span className="text-[14px] leading-[20px] text-ink-muted">
            {category.description}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="font-numeric text-[18px] font-bold">
            {category.today}
          </span>
          <span className={eyebrow}>Today</span>
        </span>
      </a>
    </li>
  );
}
