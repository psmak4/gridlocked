import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** How long a Toast stays on screen. */
export const TOAST_MS = 4000;

type ToastProps = {
  children?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** Called after 4 seconds, unless the toast is focused or hovered. */
  onDismiss?: () => void;
  className?: string;
};

function Toast({
  children,
  actionLabel,
  onAction,
  onDismiss,
  className,
}: ToastProps) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held || !onDismiss) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [held, onDismiss]);

  return (
    <div
      role="status"
      data-slot="toast"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={cn(
        "flex min-h-[48px] items-center gap-space-3 rounded-radius-m bg-ink py-0 pr-space-2 pl-space-4 font-sans text-[16px] font-semibold text-surface",
        className,
      )}
    >
      <span>{children}</span>
      {actionLabel ? (
        <Button
          variant="quiet"
          onClick={onAction}
          className="ml-auto min-h-[44px] border-0 bg-transparent px-space-2 font-sans text-[16px] font-semibold tracking-normal text-surface normal-case underline"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export { Toast };
export type { ToastProps };
