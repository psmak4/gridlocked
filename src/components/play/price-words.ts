import { formatMoney, type MoneyUnits } from "@/lib/money";

/** "Up $1.0M since last race.", "Down $0.3M…", "No change since last race." */
export function teamValueWords(change: MoneyUnits | null): string | null {
  if (change === null) return null;
  if (change === 0) return "No change since last race.";
  return `${change > 0 ? "Up" : "Down"} ${formatMoney(Math.abs(change))} since last race.`;
}
