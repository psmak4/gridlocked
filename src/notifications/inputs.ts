import { z } from "zod";

/** "Mark all as read", or the rows a person opened. */
export const markReadInput = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
]);

/** A browser's `PushSubscription`, as `toJSON()` gives it. */
export const subscribeInput = z.object({
  endpoint: z.url().max(2048).startsWith("https://"),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});

export const unsubscribeInput = z.object({
  endpoint: z.string().min(1).max(2048),
});
