import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/money";

type BudgetMeterProps = {
  /** $M spent, e.g. 97.8. */
  spent: number;
  /** $M cap: the team's purchasing power. Default 100. */
  cap?: number;
  className?: string;
};

const units = (millions: number) => Math.round(millions * 10);
const money = (u: number) => formatMoney(u, { trimWhole: true });

/** How much of the team's money is spent: a volt bar and the same in words. */
function BudgetMeter({ spent, cap = 100, className }: BudgetMeterProps) {
  const spentUnits = units(spent);
  const capUnits = units(cap);
  const over = spentUnits > capUnits;
  const text = over
    ? `Over by ${money(spentUnits - capUnits)}`
    : `${money(spentUnits)} of ${money(capUnits)}`;
  const share = capUnits > 0 ? Math.min(spentUnits / capUnits, 1) : 1;
  return (
    <div
      data-slot="budget-meter"
      className={cn("flex items-center gap-[10px]", className)}
    >
      <div
        role="meter"
        aria-label="Budget used"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(spent, cap)}
        aria-valuetext={text}
        className="h-[10px] flex-1 overflow-hidden rounded-[5px] bg-surface-sunken"
      >
        <div
          className={cn("h-full rounded-[5px]", over ? "bg-heat" : "bg-volt")}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      <span
        aria-hidden="true"
        className={cn(
          "font-numeric text-[16px] font-bold whitespace-nowrap tabular-nums",
          over && "text-fall",
        )}
      >
        {text}
      </span>
    </div>
  );
}

export { BudgetMeter };
export type { BudgetMeterProps };
