/**
 * The push sheet's three moves, wired to the browser and the server
 * functions. Client-side only (called from the sheet after hydration).
 */
import {
  getPushKeyFn,
  subscribePushFn,
  unsubscribePushFn,
} from "@/server/notifications";
import {
  pushState,
  turnOffPush,
  turnOnPush,
  type PushState,
} from "./push-client";

type SheetState = PushState | "no_key";

let key: string | null | undefined;
async function publicKey(): Promise<string | null> {
  if (key === undefined) key = (await getPushKeyFn()).publicKey;
  return key;
}

/** No key on the site means no push, whatever this browser could do. */
export async function loadPush(): Promise<SheetState> {
  if (!(await publicKey())) return "no_key";
  return pushState();
}

export async function pushOn(): Promise<SheetState> {
  const k = await publicKey();
  if (!k) return "no_key";
  const result = await turnOnPush(k);
  if (typeof result === "string") return result;
  await subscribePushFn({ data: result });
  return "on";
}

export async function pushOff(): Promise<SheetState> {
  const endpoint = await turnOffPush();
  if (endpoint) await unsubscribePushFn({ data: { endpoint } });
  return "off";
}
