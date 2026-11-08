import { useEffect, useRef } from "react";

/** Cloudflare's script. Loaded by a page that shows the widget, and by no other. */
export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

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
    onToken(LOCAL_TURNSTILE_TOKEN);
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
  const report = useRef(onToken);
  useEffect(() => {
    report.current = onToken;
  });

  useEffect(() => {
    if (!local && !siteKey) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    startTurnstile({
      mode: local ? "local" : "widget",
      onToken: (token) => report.current(token),
      container: container.current,
      siteKey,
    })
      .then((stopper) => {
        if (cancelled) stopper();
        else stop = stopper;
      })
      .catch(() => report.current(null));
    return () => {
      cancelled = true;
      stop?.();
      report.current(null);
    };
  }, [local, siteKey, resetKey]);

  if (local) {
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
  return <div ref={container} data-slot="turnstile" className="min-h-[65px]" />;
}
