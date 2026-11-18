/**
 * The browser half of Web Push (M7 Task 14): what this browser can do, and
 * turning push on or off for it. Only called after hydration, from a click.
 */

export type PushState =
  /** No service worker or Push API here. */
  | "unsupported"
  /** iOS Safari outside a home-screen app: push needs the app installed. */
  | "install_first"
  /** The person blocked notifications for the site. */
  | "denied"
  | "off"
  | "on";

/** iPhone and iPad, including iPadOS that says it's a Mac. */
export function isIos(nav: Navigator): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.userAgent.includes("Macintosh") && nav.maxTouchPoints > 1)
  );
}

/** Running as an installed app (from the home screen). */
export function isStandalone(win: Window): boolean {
  return (
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** The state of push in this browser, without asking anything. */
export async function pushState(win: Window = window): Promise<PushState> {
  const nav = win.navigator;
  if (isIos(nav) && !isStandalone(win)) return "install_first";
  if (!("serviceWorker" in nav) || !("PushManager" in win)) {
    return "unsupported";
  }
  const notification = (win as Window & { Notification?: typeof Notification })
    .Notification;
  if (notification?.permission === "denied") return "denied";
  const registration = await nav.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

/** A VAPID key from its base64url text, as `subscribe` wants it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export type SubscriptionJson = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Asks for permission, registers `/sw.js` and subscribes. Returns the
 * subscription to keep, or the state that stopped it.
 */
export async function turnOnPush(
  publicKey: string,
): Promise<SubscriptionJson | "denied" | "unsupported"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return "unsupported";
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/** Unsubscribes this browser. Returns the endpoint it had, if any. */
export async function turnOffPush(): Promise<string | null> {
  const registration = await navigator.serviceWorker?.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
