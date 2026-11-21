import { useId } from "react";

/** The longest reason a staff write takes (M8). */
export const REASON_MAX = 500;

/**
 * Every staff write's reason: required, not blank, at most 500 characters.
 * The label says who sees it: "Reason (saved in the audit log)" for staff
 * only, "Reason (players see this)" for corrections and availability notes.
 */
export function ReasonField({
  label = "Reason (saved in the audit log)",
  value,
  onChange,
  error,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div data-slot="reason-field" className="flex flex-col gap-[6px] font-sans">
      <label htmlFor={id} className="text-[14px] font-bold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        required
        maxLength={REASON_MAX}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className="min-h-[96px] rounded-radius-m border-2 border-line-strong bg-surface px-space-3 py-space-2 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-invalid:border-fall"
      />
      {error ? (
        <p id={errorId} className="text-[14px] font-semibold text-fall">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A reason the server will take: something left once trimmed, and short enough. */
export function reasonReady(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= REASON_MAX;
}
