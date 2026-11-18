/**
 * How the chat screen talks to live chat (HLD §11.2, decision 19). At launch
 * the one implementation is the refresh (./refresh.ts); a WebSocket gateway
 * or Ably can take its place later without touching the screen.
 */
import type { ChatMessageView, SendChatResult } from "@/community/chat";

export type { ChatMessageView, SendChatResult };

export interface RealtimeChannel {
  /**
   * Calls `onMessages` with the thread's messages on screen, oldest first,
   * each time they change. Returns the unsubscribe.
   */
  subscribe(
    threadId: string,
    onMessages: (messages: ChatMessageView[]) => void,
  ): () => void;
  send(threadId: string, body: string): Promise<SendChatResult>;
}

/** The start of the window `atMs` falls in: every client asks for the same URL. */
export function windowStart(atMs: number, windowSeconds: number): number {
  const size = windowSeconds * 1000;
  return Math.floor(atMs / size) * size;
}

/** The refresh URL for a thread's window. */
export const refreshUrl = (threadId: string, startMs: number) =>
  `/api/chat/${threadId}?after=${new Date(startMs).toISOString()}`;

/** At most this many messages stay on screen; older ones scroll away. */
export const ON_SCREEN = 200;

/**
 * Folds a refresh into what is on screen. The refresh is the latest messages
 * up to its window's end, so inside its span it is the truth: anything on
 * screen there that it lacks was removed. Older messages stay, and a message
 * sent here after the window was read stays until a refresh carries it.
 */
export function mergeRefresh(
  shown: ChatMessageView[],
  latest: ChatMessageView[],
): ChatMessageView[] {
  if (latest.length === 0) return shown;
  const first = latest[0]!.id;
  const last = latest[latest.length - 1]!.id;
  const merged = [
    ...shown.filter((m) => m.id < first),
    ...latest,
    ...shown.filter((m) => m.id > last),
  ];
  return merged.slice(-ON_SCREEN);
}

/** Adds one message (the viewer's own, just sent) in id order, once. */
export function addMessage(
  shown: ChatMessageView[],
  message: ChatMessageView,
): ChatMessageView[] {
  if (shown.some((m) => m.id === message.id)) return shown;
  return [...shown, message]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-ON_SCREEN);
}
