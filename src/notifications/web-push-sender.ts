/**
 * The real `PushSender`: web-push 3.6.7 with the owner's VAPID pair
 * (decision 4). `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set by the
 * owner and declared for the function only when both are; without them
 * there's no sender and `push_fanout` sends nothing. Values are never logged.
 */
import webPush from "web-push";
import type { PushResult, PushSender, PushTarget } from "./push";

/** Who to contact about this sender: the push services' only use for it. */
const DEFAULT_SUBJECT = "https://github.com/psmak4/gridlocked";

/** A day: a lock reminder or a score that waited longer is old news. */
const TTL_SECONDS = 24 * 60 * 60;

export function createWebPushSender(keys: {
  publicKey: string;
  privateKey: string;
  subject?: string;
}): PushSender {
  const vapidDetails = {
    subject: keys.subject || DEFAULT_SUBJECT,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  return {
    async send(target: PushTarget, payload: string): Promise<PushResult> {
      try {
        await webPush.sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          payload,
          { vapidDetails, TTL: TTL_SECONDS },
        );
        return { ok: true };
      } catch (error) {
        const status =
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : null;
        return { ok: false, status };
      }
    },
  };
}

/** The sender from the function's env, or null when either key is missing. */
export function pushSenderFromEnv(
  env: Record<string, string | undefined>,
): PushSender | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return createWebPushSender({
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT,
  });
}
