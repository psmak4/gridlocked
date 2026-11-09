import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "@/components/theme-script";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Theme = "device" | "light" | "dark";

const THEMES: { id: Theme; label: string }[] = [
  { id: "device", label: "Device" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "device";
  } catch {
    return "device";
  }
}

const listeners = new Set<() => void>();

/** Another tab's choice arrives as a `storage` event; ours by `choose`. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Stores the choice and applies it at once, as the theme script would. */
function applyTheme(next: Theme) {
  try {
    if (next === "device") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage refused: the choice still applies to this page.
  }
  const root = document.documentElement;
  if (next === "device") delete root.dataset.theme;
  else root.dataset.theme = next;
}

/**
 * Appearance: the existing `gridlocked-theme` choice on this device (the
 * script in `theme-script.tsx` applies it before paint). Native radios
 * dressed as the board's tabs, so arrow keys work. The choice lives in the
 * browser only; it isn't an account setting.
 */
export function ThemeChoice() {
  const hydrated = useHydrated();
  const theme = useSyncExternalStore(subscribe, readTheme, () => "device");

  function choose(next: Theme) {
    applyTheme(next);
    for (const listener of listeners) listener();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-3 gap-[4px] rounded-radius-m bg-surface-sunken p-[4px]"
    >
      {THEMES.map((option) => (
        <label
          key={option.id}
          className={cn(
            "flex min-h-[44px] cursor-pointer items-center justify-center rounded-radius-s text-[16px] font-bold text-ink has-checked:bg-surface has-checked:ring-1 has-checked:ring-line-strong has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring",
            !hydrated && "cursor-not-allowed opacity-45",
          )}
        >
          <input
            type="radio"
            name="theme"
            className="sr-only"
            value={option.id}
            checked={theme === option.id}
            disabled={!hydrated}
            onChange={() => choose(option.id)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
