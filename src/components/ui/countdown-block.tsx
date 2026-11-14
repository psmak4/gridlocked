import { cn } from "@/lib/utils";

type CountdownBlockProps = {
  /** Changes with the moment: "Locks in", "Qualifying starts in", "Results in". */
  label?: string;
  /** Display-ready, e.g. "1D 04:12", "47:12" or "LOCKED". */
  value: string;
  /** At most two short pairs, e.g. "$2.2M Bank". */
  stats?: { value: string; label: string }[];
  className?: string;
};

/** The heat block at the top of a weekend screen: the screen's one heat block. */
function CountdownBlock({
  label = "Locks in",
  value,
  stats,
  className,
}: CountdownBlockProps) {
  const shown = (stats ?? []).slice(0, 2);
  return (
    <section
      data-slot="countdown-block"
      aria-label={`${label} ${value}`}
      className={cn(
        "flex items-end justify-between gap-space-4 rounded-radius-l bg-heat px-[18px] py-space-4 text-on-heat",
        className,
      )}
    >
      <div>
        <span className="block font-sans text-[12px] font-bold tracking-[0.14em] uppercase">
          {label}
        </span>
        <span className="block font-display text-[54px] leading-none tabular-nums">
          {value}
        </span>
      </div>
      {shown.length > 0 ? (
        <div className="flex flex-col items-end gap-[6px] font-numeric text-[18px] font-bold">
          {shown.map((stat) => (
            <span key={stat.label}>
              {stat.value}
              <small className="ml-space-1 text-[12px] tracking-[0.08em] uppercase">
                {stat.label}
              </small>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export { CountdownBlock };
export type { CountdownBlockProps };
