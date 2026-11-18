import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Writer } from "@/community/writer";
import { Button } from "@/components/ui/button";
import { systemTimer } from "@/lib/clock";
import type { ChatMessageView, RealtimeChannel } from "@/realtime/channel";
import { CHAT_BODY_MAX } from "@/community/limits";
import { FAILED, refusalWords } from "./forum-words";

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

/** "Wait 6s" until slow mode lets the next message through. */
function useCountdown() {
  const [until, setUntil] = useState(0);
  const [nowMs, setNowMs] = useState(() => systemTimer.now());
  useEffect(() => {
    if (until <= nowMs) return;
    const id = setInterval(() => setNowMs(systemTimer.now()), 250);
    return () => clearInterval(id);
  }, [until, nowMs]);
  const left = Math.max(0, Math.ceil((until - nowMs) / 1000));
  return {
    left,
    wait: (seconds: number) => {
      const now = systemTimer.now();
      setNowMs(now);
      setUntil(now + seconds * 1000);
    },
  };
}

/**
 * Live chat (wave 2): flat, newest at the bottom, and a send bar that waits
 * out slow mode. Messages arrive with each refresh, every few seconds, so
 * the screen says that rather than promising live speed.
 */
export function ChatView({
  threadId,
  channel,
  writer,
  slowSeconds,
  phrase,
  signInHref,
  onClosed,
}: {
  threadId: string;
  channel: RealtimeChannel;
  writer: Writer;
  slowSeconds: number;
  /** "the race", "qualifying": what to say something about. */
  phrase: string;
  signInHref: string;
  /** Chat closed under the viewer: show the discussion instead. */
  onClosed: () => void;
}) {
  const id = useId();
  const [messages, setMessages] = useState<ChatMessageView[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { left, wait } = useCountdown();
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(
    () => channel.subscribe(threadId, (list) => setMessages(list)),
    [channel, threadId],
  );

  // Keep the newest in view while the reader is at the bottom.
  useEffect(() => {
    const onScroll = () => {
      const fromBottom =
        document.documentElement.scrollHeight -
        (window.scrollY + window.innerHeight);
      pinned.current = fromBottom < 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const canSend = writer !== null && writer.canPost;
  const header = useMemo(
    () =>
      slowSeconds > 0
        ? `Live chat · Slow mode: one message every ${slowSeconds} seconds`
        : "Live chat",
    [slowSeconds],
  );

  async function submit() {
    const text = body.trim();
    if (!text || left > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await channel.send(threadId, text);
      if (result.ok) {
        setBody("");
        if (slowSeconds > 0) wait(slowSeconds);
      } else if (result.error === "slow_mode" && result.retryAfterSeconds) {
        wait(result.retryAfterSeconds);
      } else if (result.error === "chat_closed") {
        onClosed();
      } else {
        setError(refusalWords(result));
      }
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-space-3"
    >
      <div className="flex flex-col gap-space-1">
        <h2
          id={`${id}-title`}
          className="m-0 text-[14px] font-bold tracking-[0.04em] text-heat-text"
        >
          {header}
        </h2>
        {slowSeconds > 0 ? (
          <p className="m-0 rounded-radius-m bg-surface-sunken px-space-3 py-space-2 text-[14px]">
            Slow mode is on to keep chat readable at the start.
          </p>
        ) : null}
        <p className="m-0 text-[14px] text-ink-muted">
          New messages appear every few seconds.
        </p>
      </div>

      {messages === null ? (
        <p className="m-0 text-[16px] text-ink-muted">Loading chat…</p>
      ) : messages.length === 0 ? (
        <p className="m-0 text-[16px] text-ink-muted">No messages yet.</p>
      ) : (
        <ol
          role="log"
          aria-label="Chat messages"
          className="m-0 flex list-none flex-col gap-space-2 p-0"
        >
          {messages.map((m) => (
            <li
              key={m.id}
              data-chat={m.id}
              className="text-[16px] leading-[22px] break-words"
            >
              <span className="font-bold">{m.author}</span>{" "}
              <span>{m.body}</span>{" "}
              <time
                dateTime={m.createdAt}
                className="text-[12px] text-ink-muted"
              >
                {time.format(Date.parse(m.createdAt))}
              </time>
            </li>
          ))}
        </ol>
      )}
      <div ref={end} />

      <div className="sticky bottom-0 -mx-space-4 border-t border-line bg-surface-raised px-space-4 pt-space-2 pb-[calc(var(--spacing-space-2,8px)+env(safe-area-inset-bottom))]">
        {canSend ? (
          <form
            className="flex flex-col gap-space-1"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center gap-space-2">
              <label htmlFor={`${id}-body`} className="sr-only">
                Message
              </label>
              <input
                id={`${id}-body`}
                value={body}
                maxLength={CHAT_BODY_MAX}
                placeholder={`Say something about ${phrase}`}
                autoComplete="off"
                onChange={(e) => setBody(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  [error ? `${id}-error` : null, left > 0 ? `${id}-wait` : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                className="min-h-[48px] min-w-0 flex-1 rounded-radius-m border-2 border-line-strong bg-surface px-space-3 text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              />
              <Button
                type="submit"
                disabled={busy || left > 0 || !body.trim()}
                className="min-w-[96px]"
              >
                {left > 0 ? `Wait ${left}s` : "Send"}
              </Button>
            </div>
            {left > 0 ? (
              <p
                id={`${id}-wait`}
                role="status"
                className="m-0 text-[14px] text-ink-muted"
              >
                {`You can send again in ${left} ${left === 1 ? "second" : "seconds"}.`}
              </p>
            ) : null}
            {error ? (
              <p
                id={`${id}-error`}
                role="alert"
                className="m-0 text-[14px] font-semibold text-fall"
              >
                {error}
              </p>
            ) : null}
          </form>
        ) : writer === null ? (
          <p className="m-0 min-h-[48px] content-center text-[14px] text-ink-muted">
            <a href={signInHref} className="font-bold text-ink">
              Sign in
            </a>{" "}
            to chat.
          </p>
        ) : (
          <p className="m-0 min-h-[48px] content-center text-[14px] text-ink-muted">
            Your account can’t send chat messages yet.
          </p>
        )}
      </div>
    </section>
  );
}
