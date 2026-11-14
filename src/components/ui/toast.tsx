import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** How long a Toast stays on screen. */
export const TOAST_MS = 4000;

type ToastProps = {
  children?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** Called after 4 seconds, unless the toast is focused or hovered with a mouse. */
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
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  // The latest callback, so an inline onDismiss doesn't restart the timer.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });
  const hasDismiss = onDismiss !== undefined;

  // Pauses while hovered or focused. On resume the full 4 seconds start again.
  useEffect(() => {
    if (held || !hasDismiss) return;
    const timer = setTimeout(() => dismiss.current?.(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [held, hasDismiss]);

  // A focus pause ends when the window loses focus: the button keeps focus
  // while the person is in another app, and the toast should still go. When
  // the window comes back, the browser focuses the button again.
  useEffect(() => {
    if (!focused) return;
    const onWindowBlur = () => setFocused(false);
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [focused]);

  // Only a mouse hovers. A tap on a touch screen also sends pointerenter, and
  // no pointerleave until the next tap elsewhere, so it would hold the toast.
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") setHovered(true);
  };
  const onPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") setHovered(false);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Blur bubbles: only focus leaving the toast ends the pause.
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  return (
    <div
      role="status"
      data-slot="toast"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      className={cn(
        "flex min-h-[48px] items-center gap-space-3 rounded-radius-m bg-ink shadow-[var(--shadow-sheet)] py-0 pr-space-2 pl-space-4 font-sans text-[16px] font-semibold text-surface",
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
