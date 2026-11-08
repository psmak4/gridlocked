import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/use-hydrated";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-space-2 rounded-radius-m border-2 border-transparent px-space-4 font-display uppercase select-none whitespace-nowrap cursor-pointer no-underline transition-transform active:not-disabled:scale-[0.98] motion-reduce:transition-none motion-reduce:active:not-disabled:scale-100 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-heat text-on-heat",
        secondary: "border-ink bg-transparent text-ink",
        quiet: "bg-surface-raised text-ink",
      },
      size: {
        m: "min-h-[44px] text-[16px] tracking-[0.04em]",
        l: "min-h-[52px] text-[18px] tracking-[0.06em]",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "m", block: false },
  },
);

type ButtonProps = Omit<ButtonPrimitive.Props, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    /**
     * Render a plain `<a href>`: it works before the client loads, so it is
     * never disabled. Everything else stays disabled until hydrated.
     */
    staticLink?: boolean;
    href?: string;
  };

function Button({
  className,
  variant,
  size,
  block,
  staticLink,
  href,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const hydrated = useHydrated();
  const classes = cn(buttonVariants({ variant, size, block }), className);
  if (staticLink) {
    return (
      <a
        href={href}
        className={classes}
        {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  }
  return (
    <ButtonPrimitive
      data-slot="button"
      className={classes}
      disabled={disabled || !hydrated}
      {...props}
    >
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
