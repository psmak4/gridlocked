import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-[5px] rounded-radius-pill px-space-2 py-[2px] font-sans text-[12px] leading-[16px] font-bold tracking-[0.06em] whitespace-nowrap uppercase",
  {
    variants: {
      tone: {
        neutral: "bg-surface-sunken text-ink",
        boost:
          "bg-volt font-display font-normal tracking-[0.04em] text-on-volt",
        caution: "border-[1.5px] border-caution px-[7px] py-[1px] text-caution",
        live: "bg-heat text-on-heat before:size-[6px] before:rounded-full before:bg-on-heat before:content-['']",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, tone, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
export type { BadgeProps };
