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
import { markReadInput } from "@/notifications/inputs";
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
