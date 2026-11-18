// The part of web-push 3.6.7 we call (it ships no types).
declare module "web-push" {
  export type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  export type RequestOptions = {
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
  };
  export type SendResult = { statusCode: number };
  export class WebPushError extends Error {
    statusCode: number;
  }
  export function sendNotification(
    subscription: PushSubscription,
    payload: string,
    options: RequestOptions,
  ): Promise<SendResult>;
  const webPush: {
    sendNotification: typeof sendNotification;
    WebPushError: typeof WebPushError;
  };
  export default webPush;
}
