import { cn } from "@/lib/utils";

/** The launch set of icons, on a 24 px grid. */
export const iconNames = [
  "home",
  "team",
  "leagues",
  "forum",
  "profile",
  "bell",
] as const;

export type IconName = (typeof iconNames)[number];

const paths: Record<IconName, string> = {
  home: "M3 11l9-7 9 7v9h-6v-6H9v6H3z",
  team: "M4 18h16M6 18V9l6-4 6 4v9M10 18v-5h4v5",
  leagues:
    "M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3",
  forum: "M4 5h16v11H9l-5 4z",
  profile: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4",
};

/**
 * A 24 px stroke icon in `currentColor`. Hidden from screen readers: it's
 * always paired with a text label.
 */
function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export { Icon };
