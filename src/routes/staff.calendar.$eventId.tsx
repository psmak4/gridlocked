import { useId, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { privateHeaders } from "@/lib/private-headers";
import {
  cancelCalendarEvent,
  getCalendarEvent,
  saveLock,
  saveSession,
} from "@/server/staff";
import {
  fromUtcInput,
  SESSION_STATUS_WORDS,
  STAFF_SESSION_STATUSES,
  type StaffSessionStatus,
  toUtcInput,
  utcLong,
} from "@/staff/calendar-words";
import { STAFF_ERROR_WORDS, type StaffResult } from "@/staff/errors";

/**
 * One event's editing panel (wave 5, M8 Task 5), beside the calendar table:
 * the lock (follow its session, or a time set by hand), each session's times
 * and status, **Mark cancelled** before the lock, and History from the audit
 * log. Every save takes a reason.
 */
export const Route = createFileRoute("/staff/calendar/$eventId")({
  loader: ({ params }) =>
    getCalendarEvent({ data: { eventId: params.eventId } }),
  head: () => ({ meta: [{ title: "Edit event · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: EventPanel,
});

const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

type Detail = Extract<
  Awaited<ReturnType<typeof getCalendarEvent>>,
  { ok: true }
>["value"];

/** A save's state: idle, sending, or what came back. */
type Sent = { state: "idle" | "busy" } | { state: "error"; words: string };

/** Runs a save, then reloads the table and the panel. */
function useSave() {
  const router = useRouter();
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const run = async (save: () => Promise<StaffResult<unknown>>) => {
    setSent({ state: "busy" });
    const answer = await save();
    if (answer.ok) {
      setSent({ state: "idle" });
      await router.invalidate();
      return true;
    }
    setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    return false;
  };
  return { sent, run };
}

function Refusal({ sent }: { sent: Sent }) {
  return sent.state === "error" ? (
    <p role="alert" className="text-[14px] font-semibold text-fall">
      {sent.words}
    </p>
  ) : null;
}

function EventPanel() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <section className="min-w-0 flex-[2_1_340px] rounded-radius-l border-2 border-ink p-space-5">
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </section>
    );
  }
  const detail = result.value;
  const { event } = detail;
  return (
    <section
      aria-labelledby="event-heading"
      // A new event gets fresh forms.
      key={event.id}
      className="flex min-w-0 flex-[2_1_340px] flex-col gap-space-4 rounded-radius-l border-2 border-ink p-space-5"
    >
      <div className="flex flex-col gap-[2px]">
        <span className={eyebrow}>EDITING · ROUND {event.round}</span>
        <h2
          id="event-heading"
          className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase"
        >
          {event.name}
        </h2>
        {event.status === "cancelled" ? (
          <span className="self-start">
            <Badge tone="caution">Cancelled</Badge>
          </span>
        ) : null}
      </div>
      {event.status === "cancelled" ? null : <LockForm detail={detail} />}
      <Sessions detail={detail} />
      {event.canCancel ? <CancelEvent detail={detail} /> : null}
      <History detail={detail} />
    </section>
  );
}

function LockForm({ detail }: { detail: Detail }) {
  const { event, sessions } = detail;
  const id = useId();
  const lockSession = sessions.find((s) => s.id === event.lockSessionId);
  const [hand, setHand] = useState(event.lockAtSource === "admin");
  const [lockAt, setLockAt] = useState(toUtcInput(new Date(event.lockAt)));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();

  const wasHand = event.lockAtSource === "admin";
  const changed =
    hand !== wasHand || (hand && lockAt !== toUtcInput(new Date(event.lockAt)));
  const when = fromUtcInput(lockAt);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!changed || !reasonReady(reason) || (hand && !when)) return;
    const ok = await run(() =>
      hand
        ? saveLock({
            data: {
              mode: "hand",
              eventId: event.id,
              lockAt: when!.toISOString(),
              reason,
            },
          })
        : saveLock({ data: { mode: "follow", eventId: event.id, reason } }),
    );
    if (ok) {
      setReason("");
      setTried(false);
    }
  };

  if (event.lockPassed) {
    return (
      <div className="flex flex-col gap-space-2">
        <span className="text-[14px] font-bold">Lock</span>
        <p className="text-[16px]">
          Locked at {utcLong(new Date(event.lockAt))}
          {wasHand ? " (set by hand)" : ""}.
        </p>
        <p className="rounded-radius-m bg-surface-raised px-[14px] py-space-3 text-[14px] leading-[20px]">
          A lock can never move to a time that has already passed.
        </p>
      </div>
    );
  }

  return (
    <form
      aria-label={`Lock for ${event.name}`}
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-space-3"
    >
      <div className="flex flex-col gap-[6px]">
        <span className="text-[14px] font-bold">
          Team locks at the start of
        </span>
        <span className="text-[16px]">
          {lockSession
            ? `${lockSession.label} · ${utcLong(new Date(lockSession.start))}`
            : "The first session"}
        </span>
      </div>
      <Switch
        id={`${id}-hand`}
        label="Set the lock time by hand"
        description="Only if the session time is wrong or unconfirmed"
        checked={hand}
        onChange={setHand}
      />
      {hand ? (
        <label className="flex flex-col gap-[6px] text-[14px] font-bold">
          Lock time (UTC)
          <input
            type="datetime-local"
            value={lockAt}
            onChange={(e) => setLockAt(e.target.value)}
            className={inputClass}
            aria-invalid={tried && !when ? true : undefined}
          />
        </label>
      ) : null}
      <p className="rounded-radius-m bg-surface-raised px-[14px] py-space-3 text-[14px] leading-[20px]">
        A lock can never move to a time that has already passed. Teams saved
        before the new time still count.
      </p>
      <ReasonField
        value={reason}
        onChange={setReason}
        error={
          tried && !reasonReady(reason)
            ? STAFF_ERROR_WORDS.reason_required
            : undefined
        }
      />
      {tried && !changed ? (
        <p role="status" className="text-[14px] text-ink-muted">
          Nothing to save: the lock is already like this.
        </p>
      ) : null}
      <Refusal sent={sent} />
      <Button
        type="submit"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Save changes
      </Button>
    </form>
  );
}

function Sessions({ detail }: { detail: Detail }) {
  return (
    <div className="flex flex-col gap-space-2 border-t border-line pt-space-3">
      <span className={eyebrow}>SESSIONS</span>
      <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
        {detail.sessions.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </ul>
    </div>
  );
}

function SessionRow({ session }: { session: Detail["sessions"][number] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(toUtcInput(new Date(session.start)));
  const [end, setEnd] = useState(toUtcInput(new Date(session.end)));
  const staffSet = (STAFF_SESSION_STATUSES as readonly string[]).includes(
    session.status,
  );
  const [status, setStatus] = useState(session.status);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();

  const timesChanged =
    start !== toUtcInput(new Date(session.start)) ||
    end !== toUtcInput(new Date(session.end));
  const statusChanged = status !== session.status;
  const from = fromUtcInput(start);
  const to = fromUtcInput(end);
  const timesOk = from !== null && to !== null && from < to;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reasonReady(reason) || (!timesChanged && !statusChanged)) return;
    if (timesChanged && !timesOk) return;
    const ok = await run(() =>
      saveSession({
        data: {
          sessionId: session.id,
          reason,
          ...(timesChanged
            ? { start: from!.toISOString(), end: to!.toISOString() }
            : {}),
          ...(statusChanged ? { status: status as StaffSessionStatus } : {}),
        },
      }),
    );
    if (ok) {
      setOpen(false);
      setReason("");
      setTried(false);
    }
  };

  return (
    <li
      data-slot="calendar-session"
      className="flex flex-col gap-space-2 rounded-radius-m bg-surface-raised px-space-3 py-space-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-bold">{session.label}</span>
          <span className="text-[14px] text-ink-muted">
            {utcLong(new Date(session.start))}
            {session.timeSource === "admin" ? " · set by hand" : ""}
          </span>
        </div>
        <div className="flex items-center gap-space-2">
          <Badge tone={session.status === "cancelled" ? "caution" : "neutral"}>
            {SESSION_STATUS_WORDS[session.status] ?? session.status}
          </Badge>
          <Button
            variant="quiet"
            aria-expanded={open}
            aria-controls={`${id}-form`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Change"}
            <span className="sr-only"> {session.label}</span>
          </Button>
        </div>
      </div>
      {open ? (
        <form
          id={`${id}-form`}
          aria-label={`Change ${session.label}`}
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-space-3 pb-space-2"
        >
          <div className="grid gap-space-3 sm:grid-cols-2">
            <label className="flex flex-col gap-[6px] text-[14px] font-bold">
              Start (UTC)
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-[6px] text-[14px] font-bold">
              End (UTC)
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          {tried && timesChanged && !timesOk ? (
            <p role="alert" className="text-[14px] font-semibold text-fall">
              The start must come before the end.
            </p>
          ) : null}
          <label className="flex flex-col gap-[6px] text-[14px] font-bold">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={inputClass}
            >
              {staffSet ? null : (
                <option value={session.status} disabled>
                  {SESSION_STATUS_WORDS[session.status] ?? session.status}
                </option>
              )}
              {STAFF_SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SESSION_STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          </label>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={
              tried && !reasonReady(reason)
                ? STAFF_ERROR_WORDS.reason_required
                : undefined
            }
          />
          {tried && !timesChanged && !statusChanged ? (
            <p role="status" className="text-[14px] text-ink-muted">
              Nothing to save: change a time or the status first.
            </p>
          ) : null}
          <Refusal sent={sent} />
          <Button
            type="submit"
            variant="secondary"
            disabled={sent.state === "busy"}
            className="self-start"
          >
            Save session
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function CancelEvent({ detail }: { detail: Detail }) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reasonReady(reason)) return;
    await run(() =>
      cancelCalendarEvent({ data: { eventId: detail.event.id, reason } }),
    );
  };
  return (
    <form
      aria-label="Cancel this event"
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-space-3 border-t border-line pt-space-3"
    >
      <span className={eyebrow}>CANCEL THIS EVENT</span>
      <p className="text-[14px] leading-[20px]">
        Every session is cancelled, chips played for it are given back, and
        nothing locks for it. Teams saved for it count at the next lock. This
        can&apos;t be undone here.
      </p>
      <ReasonField
        value={reason}
        onChange={setReason}
        error={
          tried && !reasonReady(reason)
            ? STAFF_ERROR_WORDS.reason_required
            : undefined
        }
      />
      <Refusal sent={sent} />
      <Button
        type="submit"
        variant="secondary"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Mark cancelled
      </Button>
    </form>
  );
}

function History({ detail }: { detail: Detail }) {
  return (
    <div className="flex flex-col gap-space-2 border-t border-line pt-space-3">
      <span className={eyebrow}>HISTORY</span>
      {detail.history.length === 0 ? (
        <p className="text-[14px] text-ink-muted">
          No staff changes yet. Times come from the calendar sync.
        </p>
      ) : (
        <ul
          aria-label="History"
          className="m-0 flex list-none flex-col gap-space-2 p-0"
        >
          {detail.history.map((h) => (
            <li
              key={h.id}
              data-slot="calendar-history"
              className="flex flex-col text-[14px] leading-[20px]"
            >
              <span>
                <span className="font-bold">{h.what}</span> by {h.who} ·{" "}
                {h.whenLabel}
              </span>
              {h.change.map((line) => (
                <span key={line} className="font-numeric text-ink-muted">
                  {line}
                </span>
              ))}
              {h.reason ? (
                <span className="text-ink-muted">“{h.reason}”</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
