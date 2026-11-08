import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The parts the profile and settings boards share, beside
 * `account-layout.tsx`: a small capitals heading over a group, and a row
 * that opens another page.
 */
export function SettingsGroup({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-[6px]">
      <h2
        id={id}
        className="text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A raised panel for one control or a list of rows. */
export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-radius-m bg-surface-raised",
        className,
      )}
    >
      {children}
    </div>
  );
}

const chevron = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="shrink-0"
  >
    <path d="M9 5l7 7-7 7" />
  </svg>
);

/** A plain link row ("Username", "late_braker · …"), usable before hydration. */
export function LinkRow({
  href,
  label,
  sub,
  danger,
}: {
  href: string;
  label: string;
  sub?: string | null;
  danger?: boolean;
}) {
  return (
    <a
      href={href}
      className="flex min-h-[52px] items-center justify-between gap-space-3 border-b border-line px-[14px] py-[4px] text-ink no-underline outline-none last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
    >
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "text-[16px] font-bold",
            danger ? "text-heat-text" : undefined,
          )}
        >
          {label}
        </span>
        {sub ? <span className="text-[14px] text-ink-muted">{sub}</span> : null}
      </span>
      {chevron}
    </a>
  );
}

/** A line of help under a heading or field. */
export function Help({ children }: { children: ReactNode }) {
  return (
    <p className="text-[16px] leading-[22px] text-ink-muted">{children}</p>
  );
}

/** What a refused save says; `read_only` is an admin looking through. */
export function saveMessage(error: string): string {
  if (error === "read_only") return "This session is read-only.";
  if (error === "version_conflict") {
    return "Your settings changed somewhere else. Reload this page, then try again.";
  }
  return "We couldn't save that. Try again.";
}
