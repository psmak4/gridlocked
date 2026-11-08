import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

type SwitchProps = {
  /** A stable id; ties the label and description to the switch. */
  id: string;
  label: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
};

function Switch({
  id,
  label,
  description,
  onChange,
  disabled,
  className,
  ...state
}: SwitchProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div
      data-slot="switch-row"
      className={cn(
        "flex min-h-[48px] items-center justify-between gap-space-3 font-sans text-ink",
        disabled && "opacity-45",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col">
        <label
          htmlFor={id}
          className={cn(
            "cursor-pointer text-[16px] leading-[20px] font-bold",
            disabled && "cursor-not-allowed",
          )}
        >
          {label}
        </label>
        {description ? (
          <span
            id={descriptionId}
            className="text-[14px] leading-[18px] text-ink-muted"
          >
            {description}
          </span>
        ) : null}
      </div>
      <SwitchPrimitive.Root
        {...state}
        id={id}
        disabled={disabled}
        aria-describedby={descriptionId}
        onCheckedChange={(next) => onChange?.(next)}
        data-slot="switch"
        className="relative h-[32px] w-[52px] shrink-0 cursor-pointer rounded-radius-pill border-2 border-line-strong bg-surface-sunken p-0 outline-none after:absolute after:-inset-[6px] after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-checked:border-ink data-checked:bg-ink data-disabled:cursor-not-allowed"
      >
        <SwitchPrimitive.Thumb className="pointer-events-none absolute top-[2px] left-[2px] size-[24px] rounded-full bg-surface ring-1 ring-line-strong transition-transform motion-reduce:transition-none data-checked:translate-x-[20px] data-checked:ring-0" />
      </SwitchPrimitive.Root>
    </div>
  );
}

export { Switch };
export type { SwitchProps };
