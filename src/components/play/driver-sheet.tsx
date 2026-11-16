import { Sheet } from "@/components/ui/sheet";
import type { BreakdownExtra, BreakdownRow } from "@/play/breakdown";

/** "+15", "−5", "0": a line's points with its sign. */
export const signed = (n: number) =>
  n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";

type DriverSheetProps = {
  open: boolean;
  onClose: () => void;
  row: BreakdownRow | null;
  /** "Race". */
  session: string;
  /** The team's own lines on this asset in this session: Boost, a chip. */
  extras: BreakdownExtra[];
};

/**
 * "Driver points line by line" (wave 3): what each scoring line gave the
 * driver or constructor in one session, then the team's own lines on it
 * (the Boost) and what that made for your team.
 */
export function DriverSheet({
  open,
  onClose,
  row,
  session,
  extras,
}: DriverSheetProps) {
  if (!row) return null;
  const lines = [
    ...row.lines,
    ...extras.map((e) => ({
      label: e.label.split(" · ")[0]!,
      why: e.why,
      points: e.points,
    })),
  ];
  const forTeam = row.points + extras.reduce((sum, e) => sum + e.points, 0);
  return (
    <Sheet open={open} onClose={onClose} title={`${row.title} · ${session}`}>
      {lines.length === 0 ? (
        <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
          No points in this session.
        </p>
      ) : (
        <ul
          aria-label="Points, line by line"
          className="m-0 flex list-none flex-col p-0"
        >
          {lines.map((line, i) => (
            <li
              key={i}
              className="flex min-h-[48px] items-center justify-between gap-space-3 border-b border-line py-[4px]"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-[16px] leading-[20px] font-semibold">
                  {line.label}
                </span>
                <span className="text-[14px] leading-[20px] text-ink-muted">
                  {line.why}
                </span>
              </span>
              <span className="shrink-0 font-numeric text-[18px] font-bold">
                {signed(line.points)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between py-[4px]">
        <span className="font-display text-[18px] leading-[22px] uppercase">
          For your team
        </span>
        <span className="font-numeric text-[22px] font-bold">
          {forTeam} pts
        </span>
      </div>
      <p className="m-0 text-[14px] leading-[20px] text-ink-muted">
        {"Overtakes and pit stops aren't scored in this game."}
      </p>
    </Sheet>
  );
}
