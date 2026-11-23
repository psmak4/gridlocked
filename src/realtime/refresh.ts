/**
 * The refresh channel (HLD §11.2, decision 19): every `windowSeconds` each
 * client fetches its thread's URL for the current window. The URL is the
 * same for everyone in that window, so the CDN answers the crowd from one
 * database read; the client keeps each message once.
 *
 * M9 Task 4: each client asks at its own random point in the window, so a
 * crowd doesn't arrive at once; its clock offset comes from the loader (or
 * its first answer) and from refusals only, never from a cached answer's
 * older time; and a refresh that doesn't reach what's on screen (over 50
 * messages in a window, a phone that slept) is filled from `since` first.
 */
import { systemTimer, type Timer } from "@/lib/clock";
import {
  addMessage,
  mergeGap,
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
  /** The window this answers (ISO 8601): the address's `after`. */
  windowStart?: string;
};

/** At most this many `since` pages fill one gap. */
const MOST_GAP_PAGES = 10;

export type RefreshOptions = {
  windowSeconds: number;
  /**
   * The server's clock minus this one's, so windows match the server's: the
   * loader's, fresh. Without it, the first answer's. After that only a
   * refused window (never cached) corrects it, so a held replay clock is
   * followed through its refusals.
   */
  offsetMs?: number;
  send: (threadId: string, body: string) => Promise<SendChatResult>;
  /**
   * The thread's visible messages after `afterId`, oldest first, a page of
   * 50 at most (`chatSince`). Fills what a refresh skipped.
   */
  since?: (threadId: string, afterId: string) => Promise<ChatMessageView[]>;
  /** In [0, 1): picks this client's point in the window. */
  random?: () => number;
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
  const random = opts.random ?? Math.random;
  let offset = opts.offsetMs ?? 0;
  let settled = opts.offsetMs !== undefined;
  const size = opts.windowSeconds * 1000;
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

  /**
   * What a refresh skipped: the messages after the last one on screen, up
   * to the refresh's first, page by page.
   */
  async function fill(
    threadId: string,
    shown: ChatMessageView[],
    latest: ChatMessageView[],
  ): Promise<ChatMessageView[]> {
    const last = shown.at(-1);
    const first = latest[0];
    if (!opts.since || !last || !first || first.id <= last.id) return [];
    const gap: ChatMessageView[] = [];
    let after = last.id;
    for (let i = 0; i < MOST_GAP_PAGES; i++) {
      const page = await opts.since(threadId, after);
      gap.push(...page.filter((m) => m.id < first.id));
      const end = page.at(-1);
      if (!end || page.length < 50 || end.id >= first.id) break;
      after = end.id;
    }
    return gap;
  }

  async function refresh(threadId: string): Promise<void> {
    const start = windowStart(timer.now() + offset, opts.windowSeconds);
    const response = await doFetch(refreshUrl(threadId, start), {
      credentials: "omit",
    });
    const body = (await response.json().catch(() => null)) as
      (Partial<RefreshResponse> & { now?: string }) | null;
    // A refused window is never cached, so its clock is the server's now;
    // an answer's may be a cached copy's, so only the first one counts.
    const serverNow = Date.parse(body?.now ?? "");
    if (Number.isFinite(serverNow) && (!response.ok || !settled)) {
      offset = serverNow - timer.now();
      settled = true;
    }
    if (!response.ok || !body?.messages || !body.mode) return;
    if (
      body.windowStart !== undefined &&
      body.windowStart !== new Date(start).toISOString()
    ) {
      return;
    }
    const entry = threads.get(threadId);
    if (!entry) return;
    const gap = await fill(threadId, entry.shown, body.messages);
    const now = threads.get(threadId);
    if (!now) return;
    publish(threadId, mergeRefresh(mergeGap(now.shown, gap), body.messages));
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
      // The first refresh waits a random part of a window, and each one
      // after keeps that point in its window: a crowd that opened the page
      // together still asks spread out.
      const delay = Math.floor(random() * size);
      let planned = 0;
      const loop = () => {
        if (stopped) return;
        const now = timer.now() + offset;
        planned = planned === 0 ? now : planned;
        void refresh(threadId)
          .catch(() => {})
          .finally(() => {
            if (stopped) return;
            // The offset may have moved: plan in the server's time.
            const at = timer.now() + offset;
            while (planned <= at) planned += size;
            cancel = schedule(loop, planned - at);
          });
      };
      if (delay === 0) loop();
      else cancel = schedule(loop, delay);
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
