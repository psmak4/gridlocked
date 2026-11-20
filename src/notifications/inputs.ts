import { z } from "zod";

/** "Mark all as read", or the rows a person opened. */
export const markReadInput = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
]);

/**
 * The browsers' push services. The server posts to a subscription's
 * endpoint, so it takes no other host (M7's review: no posting where a user
 * says).
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

const isPushService = (endpoint: string) => {
  const host = new URL(endpoint).hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
};

/** A browser's `PushSubscription`, as `toJSON()` gives it. */
export const subscribeInput = z.object({
  endpoint: z
    .url()
    .max(2048)
    .startsWith("https://")
    .refine(isPushService, "not a push service"),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});

export const unsubscribeInput = z.object({
  endpoint: z.string().min(1).max(2048),
});
