/**
 * The refresh channel (HLD §11.2, decision 19): every `windowSeconds` each
 * client fetches its thread's URL for the current window. The URL is the
 * same for everyone in that window, so the CDN answers the crowd from one
 * database read; the client keeps each message once.
 */
import { systemTimer, type Timer } from "@/lib/clock";
import {
  addMessage,
  mergeRefresh,
  refreshUrl,
  windowStart,
  type ChatMessageView,
  type RealtimeChannel,
  type SendChatResult,
} from "./channel";

export type RefreshResponse = {
  messages: ChatMessageView[];
  mode: "chat" | "discussion";
  /** The server's clock when it answered (a cached copy's is a little old). */
  now: string;
};

export type RefreshOptions = {
  windowSeconds: number;
  /**
   * The server's clock minus this one's, so windows match the server's.
   * Each answer corrects it, so a replay's held clock is followed too.
   */
  offsetMs?: number;
  send: (threadId: string, body: string) => Promise<SendChatResult>;
  /** Told when the thread leaves chat mode. */
  onModeChange?: (mode: "chat" | "discussion") => void;
  fetch?: typeof fetch;
  timer?: Timer;
  /** Waits; a test passes one it controls. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

const defaultSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createRefreshChannel(opts: RefreshOptions): RealtimeChannel {
  const timer = opts.timer ?? systemTimer;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const schedule = opts.schedule ?? defaultSchedule;
  let offset = opts.offsetMs ?? 0;
  // Per thread: what is on screen, and who wants to know.
  const threads = new Map<
    string,
    {
      shown: ChatMessageView[];
      /** A refresh has answered: even an empty chat is news then. */
      loaded: boolean;
      listeners: Set<(m: ChatMessageView[]) => void>;
    }
  >();

  const publish = (threadId: string, shown: ChatMessageView[]) => {
    const entry = threads.get(threadId);
    if (!entry || (entry.loaded && entry.shown === shown)) return;
    entry.shown = shown;
    entry.loaded = true;
    for (const listener of entry.listeners) listener(shown);
  };

  async function refresh(threadId: string): Promise<void> {
    const start = windowStart(timer.now() + offset, opts.windowSeconds);
    const response = await doFetch(refreshUrl(threadId, start), {
      credentials: "omit",
    });
    const body = (await response.json().catch(() => null)) as
      (Partial<RefreshResponse> & { now?: string }) | null;
    // Any answer that carries the server's clock lines this one up with it,
    // a refused window's included.
    const serverNow = Date.parse(body?.now ?? "");
    if (Number.isFinite(serverNow)) offset = serverNow - timer.now();
    if (!response.ok || !body?.messages || !body.mode) return;
    const entry = threads.get(threadId);
    if (!entry) return;
    publish(threadId, mergeRefresh(entry.shown, body.messages));
    opts.onModeChange?.(body.mode);
  }

  return {
    subscribe(threadId, onMessages) {
      let entry = threads.get(threadId);
      if (!entry) {
        entry = { shown: [], loaded: false, listeners: new Set() };
        threads.set(threadId, entry);
      }
      entry.listeners.add(onMessages);
      let stopped = false;
      let cancel = () => {};
      const loop = () => {
        if (stopped) return;
        void refresh(threadId)
          .catch(() => {})
          .finally(() => {
            if (stopped) return;
            // Wake at the next window's start, so each fetch is a new URL.
            const now = timer.now() + offset;
            const next =
              windowStart(now, opts.windowSeconds) +
              opts.windowSeconds * 1000 -
              now;
            cancel = schedule(loop, next);
          });
      };
      loop();
      return () => {
        stopped = true;
        cancel();
        entry.listeners.delete(onMessages);
        if (entry.listeners.size === 0) threads.delete(threadId);
      };
    },

    async send(threadId, body) {
      const result = await opts.send(threadId, body);
      const entry = threads.get(threadId);
      if (result.ok && entry) {
        publish(threadId, addMessage(entry.shown, result.message));
      }
      return result;
    },
  };
}
