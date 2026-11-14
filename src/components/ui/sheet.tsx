import { Dialog } from "@base-ui/react/dialog";
import { useRef, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type SheetProps = {
  title?: string;
  children?: ReactNode;
  /**
   * Leave out for a static panel (the design system's preview). Give it, with
   * `onClose`, for a real sheet: a modal dialog that traps focus.
   */
  open?: boolean;
  /** Called on Cancel, Escape, a tap outside or a swipe down. */
  onClose?: () => void;
  /** One or two buttons, shown before Cancel. */
  actions?: ReactNode;
  className?: string;
};

/** How far a swipe down from the grab handle closes the sheet. */
const SWIPE_CLOSE_PX = 80;

const panel =
  "flex flex-col gap-space-4 bg-surface-raised px-space-4 pt-space-2 pb-space-5 text-ink shadow-[var(--shadow-sheet)]";
const titleClass =
  "m-0 font-display text-[24px] leading-[28px] font-normal uppercase";

function Grab() {
  return (
    <span
      aria-hidden="true"
      className="h-[4px] w-[40px] rounded-[2px] bg-line-strong"
    />
  );
}

/**
 * A panel for a short, focused task. Under 1024 px it's a bottom sheet; from
 * 1024 px a centered dialog with the same content.
 */
function Sheet({
  title,
  children,
  open,
  onClose,
  actions,
  className,
}: SheetProps) {
  const swipeStart = useRef<number | null>(null);

  if (open === undefined) {
    return (
      <section
        data-slot="sheet"
        aria-label={title}
        className={cn(panel, "rounded-t-radius-l", className)}
      >
        <span className="flex justify-center">
          <Grab />
        </span>
        {title ? <h2 className={titleClass}>{title}</h2> : null}
        {children}
      </section>
    );
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swipeStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start !== null && event.clientY - start >= SWIPE_CLOSE_PX) onClose?.();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-surface/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup
          data-slot="sheet"
          className={cn(
            panel,
            "fixed inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-radius-l outline-none",
            "transition-transform duration-150 data-ending-style:translate-y-full data-starting-style:translate-y-full motion-reduce:transition-none",
            "lg:top-1/2 lg:right-auto lg:bottom-auto lg:left-1/2 lg:w-[480px] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-radius-l lg:data-ending-style:-translate-y-1/2 lg:data-ending-style:opacity-0 lg:data-starting-style:-translate-y-1/2 lg:data-starting-style:opacity-0",
            className,
          )}
        >
          {/* The grab handle: a swipe down from here closes the sheet. */}
          <div
            data-slot="sheet-grab"
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              swipeStart.current = null;
            }}
            className="-mx-space-4 -mt-space-2 flex h-[24px] cursor-grab touch-none items-center justify-center lg:hidden"
          >
            <Grab />
          </div>
          {title ? (
            <Dialog.Title className={titleClass}>{title}</Dialog.Title>
          ) : null}
          {children}
          <div className="flex flex-col gap-space-2">
            {actions}
            <Dialog.Close render={<Button variant="secondary" block />}>
              Cancel
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Sheet };
export type { SheetProps };
