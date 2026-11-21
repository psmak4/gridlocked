import { useId, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TeamBadge } from "@/components/ui/team-badge";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import {
  addDriver,
  getSeats,
  moveDriver,
  saveAvailability,
  type SeatsInput,
} from "@/server/staff";
import { STAFF_ERROR_WORDS, type StaffResult } from "@/staff/errors";

/** The tab and the event, from the address, so a view can be linked. */
function seatsSearch(search: Record<string, unknown>): SeatsInput {
  const text = (key: string) =>
    typeof search[key] === "string" && search[key] !== ""
      ? (search[key] as string)
      : undefined;
  return { team: text("team"), event: text("event") };
}

/**
 * Drivers, seats and availability (wave 5, M8 Task 6): the season's seats
 * as date ranges by team, **Move a driver from a date** and **Add a new
 * driver**, and the next event's availability, which players see as
 * warnings only.
 */
export const Route = createFileRoute("/staff/seats")({
  validateSearch: seatsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getSeats({ data: deps }),
  head: () => ({ meta: [{ title: "Drivers and seats · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: Seats,
});

const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const labelClass = "flex flex-col gap-[6px] text-[14px] font-bold";
const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

type Data = Extract<
  Awaited<ReturnType<typeof getSeats>>,
  { ok: true }
>["value"];

type Sent = { state: "idle" | "busy" } | { state: "error"; words: string };

/** Runs a save, then reloads the screen. */
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

const reasonError = (tried: boolean, value: string) =>
  tried && !reasonReady(value) ? STAFF_ERROR_WORDS.reason_required : undefined;

function Seats() {
  const result = Route.useLoaderData();
  const search = Route.useSearch();
  const [form, setForm] = useState<"move" | "add" | null>(null);
  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Drivers and seats
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const data = result.value;
  const tabs = [
    { slug: undefined, name: "All teams" },
    ...data.table.teams.map((tm) => ({ slug: tm.slug, name: tm.name })),
  ];
  const hrefFor = (team: string | undefined) => {
    const params = new URLSearchParams();
    if (team) params.set("team", team);
    if (search.event) params.set("event", search.event);
    const query = params.toString();
    return `/staff/seats${query ? `?${query}` : ""}`;
  };

  return (
    <>
      <header className="flex flex-col gap-space-3">
        <div className="flex flex-col gap-space-1">
          <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
            Drivers and seats
          </h1>
          <p className="text-[16px] text-ink-muted">
            Seats change by date, so renumbered rounds don&apos;t move them.
            Past seats are never edited, only closed.
          </p>
        </div>
        <nav aria-label="Team" className="flex flex-wrap gap-space-1">
          {tabs.map((tab) => {
            const current = tab.slug === search.team;
            return (
              <a
                key={tab.slug ?? "all"}
                href={hrefFor(tab.slug)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] items-center rounded-radius-pill px-space-3 text-[14px] font-bold no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                  current
                    ? "bg-ink text-surface"
                    : "bg-surface-raised text-ink hover:underline",
                )}
              >
                {tab.name}
              </a>
            );
          })}
        </nav>
      </header>

      <div className="flex flex-wrap items-start gap-space-5">
        <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-space-3">
          <SeatTable data={data} />
          <div className="flex flex-wrap gap-space-2">
            <Button
              variant="secondary"
              aria-expanded={form === "move"}
              onClick={() => setForm(form === "move" ? null : "move")}
            >
              Move a driver from a date
            </Button>
            <Button
              variant="quiet"
              aria-expanded={form === "add"}
              onClick={() => setForm(form === "add" ? null : "add")}
            >
              Add a new driver
            </Button>
          </div>
          {form === "move" ? (
            <MoveForm data={data} onDone={() => setForm(null)} />
          ) : null}
          {form === "add" ? (
            <AddForm data={data} onDone={() => setForm(null)} />
          ) : null}
        </div>
        <AvailabilityPanel data={data} />
      </div>
    </>
  );
}

const SEAT_COLUMNS = ["DRIVER", "CAR", "ROLE", "FROM", "UNTIL"] as const;

/** A cell that shows its column's name above it on a phone. */
const stacked =
  "py-[10px] max-sm:flex max-sm:items-center max-sm:gap-space-2 max-sm:py-[2px] max-sm:before:w-[56px] max-sm:before:text-[12px] max-sm:before:font-bold max-sm:before:tracking-[0.12em] max-sm:before:text-ink-muted max-sm:before:uppercase max-sm:before:content-[attr(data-label)] sm:px-space-2";

function SeatTable({ data }: { data: Data }) {
  if (data.table.seats.length === 0) {
    return (
      <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
        No seats for {data.table.season} yet. They come with the calendar sync.
      </p>
    );
  }
  return (
    // On a phone each seat stacks, with its column names, as the audit log's rows do.
    <div className="rounded-radius-l bg-surface-raised">
      <table
        aria-label="Seats"
        className="w-full border-collapse text-left text-[16px]"
      >
        <thead className="max-sm:sr-only">
          <tr className="text-[12px] tracking-[0.12em] text-ink-muted">
            {SEAT_COLUMNS.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "py-space-3 font-bold",
                  i === 0 || i === SEAT_COLUMNS.length - 1
                    ? "px-space-4"
                    : "px-space-2",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.table.seats.map((s) => (
            <tr
              key={s.id}
              data-slot="seat-row"
              className="border-t border-line max-sm:flex max-sm:flex-col max-sm:px-space-4 max-sm:py-space-2"
            >
              <td className="py-[10px] font-bold max-sm:py-[2px] sm:px-space-4">
                {s.driver}
              </td>
              <td data-label="Car" className={stacked}>
                <span className="flex items-center gap-space-2">
                  <TeamBadge code={s.code} color={s.color} size="s" />
                  <span className="font-numeric text-[14px] text-ink-muted">
                    #{s.carNumber}
                  </span>
                </span>
              </td>
              <td data-label="Role" className={cn(stacked, "text-ink-muted")}>
                {s.role}
              </td>
              <td data-label="From" className={stacked}>
                {s.from}
              </td>
              <td data-label="Until" className={cn(stacked, "sm:px-space-4")}>
                {s.until}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const eventLabel = (e: { round: number; name: string; day: string }) =>
  `Round ${e.round} · ${e.name} · from ${e.day}`;

function MoveForm({ data, onDone }: { data: Data; onDone: () => void }) {
  const [fromEventId, setFrom] = useState(data.events[0]?.id ?? "");
  const [driverId, setDriver] = useState("");
  const [constructorId, setTeam] = useState("");
  const [carNumber, setCar] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const ends = constructorId === "none";
  const car = Number.parseInt(carNumber, 10);
  const ready =
    fromEventId !== "" &&
    driverId !== "" &&
    constructorId !== "" &&
    (ends || Number.isInteger(car)) &&
    reasonReady(reason);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ready) return;
    const ok = await run(() =>
      moveDriver({
        data: {
          fromEventId,
          driverId,
          constructorId: ends ? null : constructorId,
          ...(ends ? {} : { carNumber: car }),
          reason,
        },
      }),
    );
    if (ok) onDone();
  };

  return (
    <form
      aria-label="Move a driver from a date"
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-5"
    >
      <p className="text-[14px] leading-[20px]">
        Their seat closes the day before the event&apos;s first session, and the
        new one opens on it. Every later event&apos;s entries follow.
      </p>
      <label className={labelClass}>
        From
        <select
          value={fromEventId}
          onChange={(e) => setFrom(e.target.value)}
          className={inputClass}
        >
          {data.events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {eventLabel(ev)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Driver
        <select
          value={driverId}
          onChange={(e) => setDriver(e.target.value)}
          className={inputClass}
          aria-invalid={tried && driverId === "" ? true : undefined}
        >
          <option value="">Choose a driver</option>
          {data.drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        New team
        <select
          value={constructorId}
          onChange={(e) => setTeam(e.target.value)}
          className={inputClass}
          aria-invalid={tried && constructorId === "" ? true : undefined}
        >
          <option value="">Choose a team</option>
          {data.table.teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
          <option value="none">No seat: their seat just ends</option>
        </select>
      </label>
      {ends ? null : (
        <label className={labelClass}>
          Car number
          <input
            inputMode="numeric"
            value={carNumber}
            onChange={(e) => setCar(e.target.value.replace(/\D/g, ""))}
            className={inputClass}
            aria-invalid={tried && !Number.isInteger(car) ? true : undefined}
          />
        </label>
      )}
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError(tried, reason)}
      />
      {tried && !ready && reasonReady(reason) ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          Choose the event, the driver, the team and a car number.
        </p>
      ) : null}
      <Refusal sent={sent} />
      <Button
        type="submit"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Move driver
      </Button>
    </form>
  );
}

function AddForm({ data, onDone }: { data: Data; onDone: () => void }) {
  const [eventId, setEvent] = useState(data.events[0]?.id ?? "");
  const [inDriverId, setIn] = useState("");
  const [constructorId, setTeam] = useState("");
  const [carNumber, setCar] = useState("");
  const [outDriverId, setOut] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const car = Number.parseInt(carNumber, 10);
  const ready =
    eventId !== "" &&
    inDriverId !== "" &&
    constructorId !== "" &&
    Number.isInteger(car) &&
    reasonReady(reason);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ready) return;
    const ok = await run(() =>
      addDriver({
        data: {
          eventId,
          inDriverId,
          constructorId,
          carNumber: car,
          outDriverId: outDriverId === "" ? null : outDriverId,
          reason,
        },
      }),
    );
    if (ok) onDone();
  };

  return (
    <form
      aria-label="Add a new driver"
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-5"
    >
      <p className="text-[14px] leading-[20px]">
        For one event only: a stand-in drives that weekend, and the driver they
        replace is marked unavailable for it.
      </p>
      <label className={labelClass}>
        Event
        <select
          value={eventId}
          onChange={(e) => setEvent(e.target.value)}
          className={inputClass}
        >
          {data.events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {eventLabel(ev)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Driver
        <select
          value={inDriverId}
          onChange={(e) => setIn(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose a driver</option>
          {data.drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Team
        <select
          value={constructorId}
          onChange={(e) => setTeam(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose a team</option>
          {data.table.teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Car number
        <input
          inputMode="numeric"
          value={carNumber}
          onChange={(e) => setCar(e.target.value.replace(/\D/g, ""))}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Replaces
        <select
          value={outDriverId}
          onChange={(e) => setOut(e.target.value)}
          className={inputClass}
        >
          <option value="">Nobody</option>
          {data.drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError(tried, reason)}
      />
      {tried && !ready && reasonReady(reason) ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          Choose the event, the driver, the team and a car number.
        </p>
      ) : null}
      <Refusal sent={sent} />
      <Button
        type="submit"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Add driver
      </Button>
    </form>
  );
}

const STATUS_WORDS = {
  available: "Available",
  doubtful: "Doubtful",
  unavailable: "Unavailable",
  reserve: "Reserve",
} as const;
type Status = keyof typeof STATUS_WORDS;

function AvailabilityPanel({ data }: { data: Data }) {
  const panel = data.availability;
  if (!panel) {
    return (
      <section className="min-w-0 flex-[2_1_340px] rounded-radius-l border-2 border-ink p-space-5">
        <p className="text-[16px] text-ink-muted">
          No event is coming up, so there&apos;s no availability to set.
        </p>
      </section>
    );
  }
  const { event } = panel;
  return (
    <section
      aria-labelledby="availability-heading"
      className="flex min-w-0 flex-[2_1_340px] flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-5"
    >
      <div className="flex flex-col gap-[2px]">
        <span className={eyebrow}>AVAILABILITY · ROUND {event.round}</span>
        <h2
          id="availability-heading"
          className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase"
        >
          {event.name}
        </h2>
        <span className="text-[14px] text-ink-muted">
          Shown to players as warnings. Points always come from the results.
        </span>
      </div>
      <form
        method="get"
        action="/staff/seats"
        className="flex items-end gap-space-2"
      >
        <label className={cn(labelClass, "min-w-0 flex-1")}>
          Event
          <select name="event" defaultValue={event.id} className={inputClass}>
            {data.events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {eventLabel(ev)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="quiet">
          Show
        </Button>
      </form>
      {event.locked ? (
        <p className="text-[14px] text-ink-muted">
          This event has locked, so its availability can&apos;t change here.
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {panel.drivers.map((d) => (
          <AvailabilityRow
            key={d.driverId}
            eventId={event.id}
            locked={event.locked}
            total={panel.teams}
            row={d}
          />
        ))}
      </ul>
    </section>
  );
}

function AvailabilityRow({
  eventId,
  locked,
  total,
  row,
}: {
  eventId: string;
  locked: boolean;
  total: number;
  row: NonNullable<Data["availability"]>["drivers"][number];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>(row.status);
  const [note, setNote] = useState(row.note ?? "");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const share = total > 0 ? Math.round((row.teams / total) * 100) : 0;
  const changed = status !== row.status || note.trim() !== (row.note ?? "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!changed || !reasonReady(note)) return;
    const ok = await run(() =>
      saveAvailability({
        data: { eventId, driverId: row.driverId, status, note },
      }),
    );
    if (ok) {
      setOpen(false);
      setTried(false);
    }
  };

  return (
    <li
      data-slot="availability-row"
      className="flex flex-col gap-space-2 border-t border-line py-space-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <span className="flex min-w-0 items-center gap-space-2">
          <TeamBadge code={row.code} color={row.color} size="s" />
          <span className="font-bold">{row.driver}</span>
          <span className="text-[14px] text-ink-muted">
            in {share}% of teams
          </span>
        </span>
        <span className="flex items-center gap-space-2">
          <Badge tone={row.status === "available" ? "neutral" : "caution"}>
            {STATUS_WORDS[row.status]}
          </Badge>
          {locked ? null : (
            <Button
              variant="quiet"
              aria-expanded={open}
              aria-controls={`${id}-form`}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Close" : "Change"}
              <span className="sr-only"> {row.driver}</span>
            </Button>
          )}
        </span>
      </div>
      {row.note && !open ? (
        <p className="text-[14px] leading-[20px] text-ink-muted">
          “{row.note}”
        </p>
      ) : null}
      {open ? (
        <form
          id={`${id}-form`}
          aria-label={`Availability for ${row.driver}`}
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-space-3"
        >
          <label className={labelClass}>
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              className={inputClass}
            >
              {(Object.keys(STATUS_WORDS) as Status[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          </label>
          <ReasonField
            label="Reason (players see this)"
            value={note}
            onChange={setNote}
            error={reasonError(tried, note)}
          />
          <p className="text-[14px] leading-[20px] text-ink-muted">
            {row.teams === 1 ? "1 team has" : `${row.teams} teams have`}{" "}
            {row.driver}. A new status tells their owners in the app, and by
            push if they have it on.
          </p>
          {tried && !changed ? (
            <p role="status" className="text-[14px] text-ink-muted">
              Nothing to save: change the status or the note first.
            </p>
          ) : null}
          <Refusal sent={sent} />
          <Button
            type="submit"
            disabled={sent.state === "busy"}
            className="self-start"
          >
            Save availability
          </Button>
        </form>
      ) : null}
    </li>
  );
}
