import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, "id" | "className"> & {
  /** A stable id; ties the label, hint and error to the checkbox. */
  id: string;
  /** Text, or text with links in it ("I agree to the Terms"). */
  label: ReactNode;
  hint?: string;
  error?: string;
  className?: string;
};

function Checkbox({
  id,
  label,
  hint,
  error,
  className,
  disabled,
  "aria-describedby": callerDescribedBy,
  ...props
}: CheckboxProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [callerDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div
      data-slot="checkbox-field"
      className={cn("flex flex-col font-sans", className)}
    >
      <div
        data-slot="checkbox-row"
        className={cn(
          "flex min-h-[48px] items-center gap-space-3",
          disabled && "opacity-45",
        )}
      >
        <CheckboxPrimitive.Root
          {...props}
          id={id}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          data-slot="checkbox"
          className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-radius-s border-2 border-line-strong bg-surface text-surface outline-none after:absolute after:-inset-[10px] after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-checked:border-ink data-checked:bg-ink data-disabled:cursor-not-allowed aria-invalid:border-fall"
        >
          <CheckboxPrimitive.Indicator className="flex items-center justify-center">
            <svg
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8.5l3.2 3.2L13 4.8" />
            </svg>
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <label
          htmlFor={id}
          className={cn(
            "cursor-pointer text-[16px] leading-[20px] font-bold text-ink",
            disabled && "cursor-not-allowed",
          )}
        >
          {label}
        </label>
      </div>
      {hint ? (
        <p id={hintId} className="text-[14px] text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[14px] font-semibold text-fall">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { Checkbox };
export type { CheckboxProps };
