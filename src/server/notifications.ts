/**
 * The notifications page's server functions (Task 13). Private answers: the
 * list is one person's, read with the request's clock.
 *
 * `createServerFn(...).validator(...).handler(...)` stays written out at the
 * top level for each function, so Start's compiler finds it.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { requireComplete, requireWritable } from "@/identity/viewer";
import {
  markReadInput,
  subscribeInput,
  unsubscribeInput,
} from "@/notifications/inputs";
import { subscribe, unsubscribe } from "@/notifications/push";
import { inbox, markRead, type InboxItem } from "@/notifications/read";
import { getViewer, withRequestNow } from "./session";

/** The last 90 days, newest first. */
export const getNotificationsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ items: InboxItem[] }> => {
    setResponseHeader("Cache-Control", "private, no-store");
    const viewer = requireComplete(await getViewer(getRequest()));
    return withRequestNow(async (db, now) => ({
      items: await inbox(db, now, viewer),
    }));
  },
);

/** "Mark all as read", or one opened. */
export const markReadFn = createServerFn({ method: "POST" })
  .validator(markReadInput)
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const viewer = requireWritable(await getViewer(getRequest()));
    await withRequestNow((db, now) => markRead(db, now, viewer, data));
    return { ok: true as const };
  });

/**
 * The site's VAPID public key, or null until the owner sets
 * `VAPID_PUBLIC_KEY` (then push stays off). Public by design.
 */
export const getPushKeyFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ publicKey: string | null }> => {
    setResponseHeader("Cache-Control", "private, no-store");
    return { publicKey: process.env.VAPID_PUBLIC_KEY || null };
  },
);

/** "Turn on": keeps this browser's subscription. */
export const subscribePushFn = createServerFn({ method: "POST" })
  .validator(subscribeInput)
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const request = getRequest();
    const viewer = requireWritable(await getViewer(request));
    const userAgent = request.headers.get("user-agent")?.slice(0, 256) ?? null;
    await withRequestNow((db, now) =>
      subscribe(db, now, viewer, {
        endpoint: data.endpoint,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        userAgent,
      }),
    );
    return { ok: true as const };
  });

/** "Turn off" for this browser. */
export const unsubscribePushFn = createServerFn({ method: "POST" })
  .validator(unsubscribeInput)
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const viewer = requireWritable(await getViewer(getRequest()));
    await withRequestNow((db) => unsubscribe(db, viewer, data));
    return { ok: true as const };
  });
