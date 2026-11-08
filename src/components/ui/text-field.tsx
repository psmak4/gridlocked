import { Input } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type TextFieldProps = Omit<ComponentProps<"input">, "id"> & {
  /** A stable id; ties the label, hint and error to the input. */
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

function TextField({
  id,
  label,
  hint,
  error,
  className,
  ...props
}: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div data-slot="text-field" className="flex flex-col gap-[6px] font-sans">
      <label htmlFor={id} className="text-[14px] font-bold text-ink">
        {label}
      </label>
      <Input
        {...props}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(
          "min-h-[48px] rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-fall",
          className,
        )}
      />
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

export { TextField };
export type { TextFieldProps };
