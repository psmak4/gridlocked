import { useEffect, useRef, useState } from "react";

/** Cloudflare's script. Loaded by a page that shows the widget, and by no other. */
export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * The stand-in exists in local builds only. The flag is replaced at build
 * time, so a deployed client bundle drops the stand-in and its token (tests
 * may use it too, under Vitest).
 */
const STAND_IN_ALLOWED =
  import.meta.env.VITE_LOCAL_DB === "1" || Boolean(import.meta.env.VITEST);

/** What the local stand-in hands over. A local build has no secret key to check it. */
export const LOCAL_TURNSTILE_TOKEN = "local-stand-in-token";

/** The header the auth server reads the token from. */
export const CAPTCHA_HEADER = "x-captcha-response";

type WidgetOptions = {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

export type TurnstileApi = {
  render: (container: HTMLElement, options: WidgetOptions) => string;
  remove: (widgetId: string) => void;
};

const loading = new WeakMap<Document, Promise<void>>();

/** Adds Cloudflare's script to the page once, however often it is asked. */
export function loadTurnstileScript(doc: Document): Promise<void> {
  const existing = loading.get(doc);
  if (existing) return existing;
  const loaded = new Promise<void>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading.delete(doc);
      reject(new Error("The bot check could not load."));
    };
    doc.head.appendChild(script);
  });
  loading.set(doc, loaded);
  return loaded;
}

async function loadApi(): Promise<TurnstileApi> {
  await loadTurnstileScript(document);
  return (window as unknown as { turnstile: TurnstileApi }).turnstile;
}

/**
 * Starts the bot check and returns what stops it. The stand-in answers at
 * once; the widget loads the script, draws itself in `container` and reports
 * each token (or `null` when one expires or the check fails).
 */
export async function startTurnstile({
  mode,
  onToken,
  loadScript = loadApi,
  container,
  siteKey,
}: {
  mode: "local" | "widget";
  onToken: (token: string | null) => void;
  loadScript?: () => Promise<TurnstileApi>;
  container: HTMLElement | null;
  siteKey: string | undefined;
}): Promise<() => void> {
  if (mode === "local") {
    if (STAND_IN_ALLOWED) onToken(LOCAL_TURNSTILE_TOKEN);
    return () => {};
  }
  if (!container || !siteKey) return () => {};
  const api = await loadScript();
  const widgetId = api.render(container, {
    sitekey: siteKey,
    callback: (token) => onToken(token),
    "expired-callback": () => onToken(null),
    "error-callback": () => onToken(null),
  });
  return () => api.remove(widgetId);
}

type TurnstileProps = {
  /** Called with a token, or null when there is none (yet, or any more). */
  onToken: (token: string | null) => void;
  /** Change it to ask for a fresh token: a token works once. */
  resetKey?: number;
  /** Override for tests. A local build (VITE_LOCAL_DB=1) uses the stand-in. */
  local?: boolean;
  siteKey?: string;
};

/**
 * Cloudflare Turnstile, for the forms the auth server guards. In a local
 * build it is a labelled stand-in, so the end-to-end tests need no network.
 */
export function Turnstile({
  onToken,
  resetKey = 0,
  local = import.meta.env.VITE_LOCAL_DB === "1",
  siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined,
}: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const standIn = STAND_IN_ALLOWED && local;
  const report = useRef(onToken);
  useEffect(() => {
    report.current = onToken;
  });

  useEffect(() => {
    if (!standIn && !siteKey) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    startTurnstile({
      mode: standIn ? "local" : "widget",
      onToken: (token) => report.current(token),
      container: container.current,
      siteKey,
    })
      .then((stopper) => {
        if (cancelled) stopper();
        else stop = stopper;
      })
      .catch(() => {
        report.current(null);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      stop?.();
      report.current(null);
    };
  }, [standIn, siteKey, resetKey, attempt]);

  if (standIn) {
    return (
      <div
        data-slot="turnstile"
        className="flex min-h-[64px] items-center justify-center rounded-radius-m border border-dashed border-line-strong text-center text-[14px] text-ink-muted"
      >
        Bot check (local stand-in)
      </div>
    );
  }
  if (!siteKey) {
    return (
      <p data-slot="turnstile" role="alert" className="text-[14px] text-fall">
        The bot check is not set up on this site.
      </p>
    );
  }
  if (failed) {
    return (
      <TurnstileFailed
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return <div ref={container} data-slot="turnstile" className="min-h-[65px]" />;
}

/** The script didn't load (blocked, or offline): say so, and offer another go. */
export function TurnstileFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-slot="turnstile"
      role="alert"
      className="flex flex-col items-start gap-space-2 text-[14px]"
    >
      <span className="font-semibold text-fall">
        The bot check didn&apos;t load.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-[44px] cursor-pointer rounded-radius-m border-2 border-ink px-space-4 font-display text-[16px] tracking-[0.04em] text-ink uppercase outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        Try again
      </button>
    </div>
  );
}
