import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

type TabsProps = {
  /** For screen readers, e.g. "Pick from". */
  label: string;
  /** Two to four views, one or two words each. */
  items: { id: string; label: string }[];
  value: string;
  onChange?: (id: string) => void;
  className?: string;
};

/**
 * A segmented switch between two to four views of the same thing. The arrow
 * keys move between tabs and select as they go.
 */
function Tabs({ label, items, value, onChange, className }: TabsProps) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(next) => onChange?.(String(next))}
    >
      <TabsPrimitive.List
        aria-label={label}
        activateOnFocus
        data-slot="tabs"
        className={cn(
          "flex gap-space-1 rounded-radius-m bg-surface-raised p-space-1",
          className,
        )}
      >
        {items.slice(0, 4).map((item) => (
          <TabsPrimitive.Tab
            key={item.id}
            value={item.id}
            className="min-h-[44px] flex-1 cursor-pointer rounded-[10px] border-0 bg-transparent font-sans text-[14px] font-bold tracking-[0.06em] text-ink-muted uppercase outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-active:bg-ink data-active:text-surface"
          >
            {item.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export { Tabs };
export type { TabsProps };
