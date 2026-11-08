import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The parts the sign-up and onboarding boards share: a phone-width column, a
 * header, a title and a bar of actions that stays at the bottom.
 */
export function Screen({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-dvh w-full max-w-[480px] flex-col",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex min-h-[44px] shrink-0 items-center justify-between px-space-2 pt-space-2">
      {children}
    </header>
  );
}

/** "Back": a plain link, so it works before the client loads. */
export function BackLink({
  href,
  children = "Back",
}: {
  href: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-[44px] items-center gap-[4px] rounded-radius-m px-space-2 text-[16px] font-bold text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M15 5l-7 7 7 7" />
      </svg>
      {children}
    </a>
  );
}

export function StepLabel({ children }: { children: ReactNode }) {
  return (
    <span className="px-space-2 text-[12px] font-bold tracking-[0.12em] text-ink-muted">
      {children}
    </span>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-display text-[32px] leading-[34px] font-normal uppercase">
      {children}
    </h1>
  );
}

/** The body of a screen. */
export function Body({
  children,
  className = "pt-space-1",
}: {
  children: ReactNode;
  /** Sets the top padding (the default is tight, under a header). */
  className?: string;
}) {
  return (
    <main
      className={cn(
        "flex flex-1 flex-col gap-[14px] px-space-4 pb-space-4",
        className,
      )}
    >
      {children}
    </main>
  );
}

/** Actions that stay on screen below the form. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 mt-auto flex shrink-0 flex-col gap-space-2 border-t border-line bg-surface px-space-4 pt-[10px] pb-space-4">
      {children}
    </div>
  );
}

/** A refusal or failure, announced as it appears. */
export function FormMessage({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[16px] font-semibold text-fall">
      {children}
    </p>
  );
}

/** A quiet note, announced politely. */
export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="status"
      className="rounded-radius-m bg-surface-raised px-space-3 py-space-3 text-[16px] font-semibold"
    >
      {children}
    </p>
  );
}

export const linkClass =
  "font-bold text-heat-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const selectClass =
  "min-h-[48px] rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
