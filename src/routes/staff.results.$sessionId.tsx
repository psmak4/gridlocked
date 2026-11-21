import { useId, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TeamBadge } from "@/components/ui/team-badge";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import {
  checkProvider,
  getSessionResults,
  revokeCorrection,
  saveCorrection,
} from "@/server/staff";
import { STAFF_ERROR_WORDS, type StaffResult } from "@/staff/errors";
import {
  CLASSIFICATION_WORDS,
  CORRECTION_FIELDS,
  CORRECTION_WORDS,
  type CorrectionField,
  RESULT_STATUS_WORDS,
} from "@/staff/result-words";

/**
 * One session's results and corrections (wave 5's results board, M8 Task 7):
 * the effective rows with what changed, **Check provider again**, "What
 * changed", and "Add a correction", whose reason players see. Saving
 * re-scores the session. There is no reopen: a correction re-scores a final
 * session (finding 9). Reached from the calendar's event panel and from
 * review items.
 */
export const Route = createFileRoute("/staff/results/$sessionId")({
  loader: ({ params }) =>
    getSessionResults({ data: { sessionId: params.sessionId } }),
  head: () => ({ meta: [{ title: "Results · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: ResultsBoard,
});

const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

type Board = Extract<
  Awaited<ReturnType<typeof getSessionResults>>,
  { ok: true }
>["value"];

type Sent =
  { state: "idle" | "busy" } | { state: "done" | "error"; words: string };

/** Runs a save, then reloads the board. */
function useSave() {
  const router = useRouter();
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const run = async (
    save: () => Promise<StaffResult<unknown>>,
    done?: string,
  ) => {
    setSent({ state: "busy" });
    const answer = await save();
    if (answer.ok) {
      setSent(done ? { state: "done", words: done } : { state: "idle" });
      await router.invalidate();
      return true;
    }
    setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    return false;
  };
  return { sent, run };
}

function Answer({ sent }: { sent: Sent }) {
  if (sent.state === "error") {
    return (
      <p role="alert" className="text-[14px] font-semibold text-fall">
        {sent.words}
      </p>
    );
  }
  return sent.state === "done" ? (
    <p role="status" className="text-[14px] text-ink-muted">
      {sent.words}
    </p>
  ) : null;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function ResultsBoard() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Results
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const board = result.value;
  return (
    <>
      <Header board={board} />
      <div className="flex flex-wrap items-start gap-space-5">
        <ResultTable board={board} />
        <aside className="flex min-w-0 flex-[2_1_340px] flex-col gap-space-5">
          <WhatChanged board={board} />
          <AddCorrection key={board.session.id} board={board} />
        </aside>
      </div>
    </>
  );
}

function Header({ board }: { board: Board }) {
  const { sent, run } = useSave();
  const active = board.overrides.filter((o) => o.active).length;
  const source = !board.source
    ? "No results yet"
    : board.source.kind === "manual"
      ? "Entered by staff"
      : `From ${board.source.provider === "jolpica" ? "Jolpica" : (board.source.provider ?? "the provider")}`;
  const line = [
    source,
    board.source?.lastCheckedLabel
      ? `last checked ${board.source.lastCheckedLabel}`
      : null,
    active === 0
      ? "no admin corrections"
      : plural(active, "admin correction", "admin corrections"),
  ].filter(Boolean);
  const canCheck =
    board.session.polled &&
    !board.session.cancelled &&
    board.status !== "final";

  return (
    <header className="flex flex-wrap items-end justify-between gap-space-4">
      <div className="flex flex-col gap-space-1">
        <span className={eyebrow}>RESULTS · ROUND {board.event.round}</span>
        <div className="flex flex-wrap items-center gap-space-3">
          <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
            {board.event.name} · {board.session.label}
          </h1>
          <Badge tone={board.status === "under_review" ? "caution" : "neutral"}>
            {RESULT_STATUS_WORDS[board.status]}
          </Badge>
        </div>
        <p className="text-[16px] text-ink-muted">{line.join(" · ")}</p>
      </div>
      {canCheck ? (
        <div className="flex flex-col items-end gap-space-1">
          <Button
            variant="secondary"
            disabled={sent.state === "busy"}
            onClick={() =>
              run(
                () => checkProvider({ data: { sessionId: board.session.id } }),
                "Check queued. It runs within a few minutes.",
              )
            }
          >
            Check provider again
          </Button>
          <Answer sent={sent} />
        </div>
      ) : null}
    </header>
  );
}

const COLUMNS = ["POS", "DRIVER", "CAR", "GRID", "STATUS", "CHANGED"] as const;

/** A cell that shows its column's name beside it on a phone. */
const stacked =
  "py-[10px] max-sm:flex max-sm:items-center max-sm:gap-space-2 max-sm:py-[2px] max-sm:before:w-[72px] max-sm:before:text-[12px] max-sm:before:font-bold max-sm:before:tracking-[0.12em] max-sm:before:text-ink-muted max-sm:before:uppercase max-sm:before:content-[attr(data-label)] sm:px-space-2";

function ResultTable({ board }: { board: Board }) {
  if (board.rows.length === 0) {
    return (
      <p className="min-w-0 flex-[3_1_560px] rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
        No results for this session yet. They arrive with the provider&apos;s
        next poll.
      </p>
    );
  }
  return (
    // On a phone each row stacks, with its column names, as the seats do.
    <div className="min-w-0 flex-[3_1_560px] rounded-radius-l bg-surface-raised">
      <table
        aria-label="Results"
        className="w-full border-collapse text-left text-[16px]"
      >
        <thead className="max-sm:sr-only">
          <tr className="text-[12px] tracking-[0.12em] text-ink-muted">
            {COLUMNS.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "py-space-3 font-bold",
                  i === 0 || i === COLUMNS.length - 1
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
          {board.rows.map((r) => (
            <tr
              key={r.driverId}
              data-slot="result-row"
              data-overridden={r.overridden ? "" : undefined}
              className="border-t border-line max-sm:flex max-sm:flex-col max-sm:px-space-4 max-sm:py-space-2"
            >
              <td
                data-label="Pos"
                className={cn(stacked, "font-numeric font-bold sm:px-space-4")}
              >
                {r.pos}
              </td>
              <td data-label="Driver" className={cn(stacked, "font-bold")}>
                {r.driver}
              </td>
              <td data-label="Car" className={stacked}>
                <span className="flex items-center gap-space-2">
                  <TeamBadge code={r.code} color={r.color} size="s" />
                  <span className="font-numeric text-[14px] text-ink-muted">
                    #{r.carNumber}
                  </span>
                </span>
              </td>
              <td data-label="Grid" className={cn(stacked, "font-numeric")}>
                {r.grid}
              </td>
              <td data-label="Status" className={stacked}>
                {r.status}
              </td>
              <td
                data-label="Changed"
                className={cn(
                  stacked,
                  "sm:px-space-4",
                  r.overridden ? "font-semibold" : "text-ink-muted",
                )}
              >
                {r.changed}
                {r.overridden && r.overrideReason ? (
                  <span className="sr-only">: {r.overrideReason}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WhatChanged({ board }: { board: Board }) {
  const empty = board.changes.length === 0 && board.overrides.length === 0;
  return (
    <section
      aria-labelledby="what-changed"
      className="flex flex-col gap-space-3 rounded-radius-l bg-surface-raised p-space-4"
    >
      <h2 id="what-changed" className={eyebrow}>
        WHAT CHANGED
      </h2>
      {empty ? (
        <p className="text-[14px] text-ink-muted">
          Nothing yet. The provider&apos;s changes and staff corrections show
          here.
        </p>
      ) : (
        <ul
          aria-label="What changed"
          className="m-0 flex list-none flex-col gap-space-3 p-0"
        >
          {board.overrides.map((o) => (
            <Correction key={o.id} correction={o} />
          ))}
          {board.changes.map((c) => (
            <li
              key={c.id}
              data-slot="result-change"
              className="flex flex-col text-[14px] leading-[20px]"
            >
              <span className="font-bold">{c.what}</span>
              <span className="text-ink-muted">
                From the provider · {c.whenLabel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Correction({
  correction,
}: {
  correction: Board["overrides"][number];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reasonReady(reason)) return;
    await run(() =>
      revokeCorrection({ data: { overrideId: correction.id, reason } }),
    );
  };
  return (
    <li
      data-slot="result-correction"
      data-active={correction.active ? "" : undefined}
      className="flex flex-col gap-space-2 text-[14px] leading-[20px]"
    >
      <div className="flex flex-wrap items-start justify-between gap-space-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-bold">
            {correction.driver}: {correction.summary}
          </span>
          <span>&ldquo;{correction.reason}&rdquo;</span>
          <span className="text-ink-muted">
            Staff correction · {correction.whenLabel}
            {correction.revokedLabel
              ? ` · revoked ${correction.revokedLabel}`
              : ""}
          </span>
        </div>
        {correction.active ? (
          <Button
            variant="quiet"
            aria-expanded={open}
            aria-controls={`${id}-form`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Revoke"}
            <span className="sr-only">
              {" "}
              the correction to {correction.driver}
            </span>
          </Button>
        ) : null}
      </div>
      {open && correction.active ? (
        <form
          id={`${id}-form`}
          aria-label={`Revoke the correction to ${correction.driver}`}
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-space-3"
        >
          <p>
            {correction.driver} goes back to the provider&apos;s row, and the
            session is re-scored.
          </p>
          <ReasonField
            label="Reason (players see this)"
            value={reason}
            onChange={setReason}
            error={
              tried && !reasonReady(reason)
                ? STAFF_ERROR_WORDS.reason_required
                : undefined
            }
          />
          <Answer sent={sent} />
          <Button
            type="submit"
            variant="secondary"
            disabled={sent.state === "busy"}
            className="self-start"
          >
            Revoke correction
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function AddCorrection({ board }: { board: Board }) {
  const [driverId, setDriver] = useState("");
  const [what, setWhat] = useState<CorrectionField>("position");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const row = board.rows.find((r) => r.driverId === driverId);
  const owners = row ? (board.owners[row.driverId] ?? 0) : 0;
  const needsValue = what !== "remove";
  const valueOk =
    !needsValue ||
    (what === "classification" ? value !== "" : /^\d+$/.test(value.trim()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!row || !valueOk || !reasonReady(reason)) return;
    const ok = await run(
      () =>
        saveCorrection({
          data: {
            sessionId: board.session.id,
            driverId: row.driverId,
            what,
            value: needsValue ? value.trim() : "",
            reason,
          },
        }),
      "Correction saved. The session is being re-scored.",
    );
    if (ok) {
      setValue("");
      setReason("");
      setTried(false);
    }
  };

  if (board.rows.length === 0) return null;
  return (
    <form
      aria-labelledby="add-correction"
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-4"
    >
      <h2 id="add-correction" className={eyebrow}>
        ADD A CORRECTION
      </h2>
      <p className="text-[14px] leading-[20px]">
        Corrections sit on top of the provider&apos;s data and survive every
        re-check. Revoke one to go back to the provider.
      </p>
      <label className="flex flex-col gap-[6px] text-[14px] font-bold">
        Driver
        <select
          value={driverId}
          onChange={(e) => setDriver(e.target.value)}
          aria-invalid={tried && !row ? true : undefined}
          className={inputClass}
        >
          <option value="">Pick a driver</option>
          {board.rows.map((r) => (
            <option key={r.driverId} value={r.driverId}>
              {r.driver} ({r.team})
            </option>
          ))}
        </select>
      </label>
      {tried && !row ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          Pick the driver to correct.
        </p>
      ) : null}
      <label className="flex flex-col gap-[6px] text-[14px] font-bold">
        What to change
        <select
          value={what}
          onChange={(e) => {
            setWhat(e.target.value as CorrectionField);
            setValue("");
          }}
          className={inputClass}
        >
          {CORRECTION_FIELDS.map((f) => (
            <option key={f} value={f}>
              {CORRECTION_WORDS[f]}
            </option>
          ))}
        </select>
      </label>
      {what === "classification" ? (
        <label className="flex flex-col gap-[6px] text-[14px] font-bold">
          New value
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={inputClass}
          >
            <option value="">Pick a status</option>
            {Object.entries(CLASSIFICATION_WORDS).map(([key, words]) => (
              <option key={key} value={key}>
                {words}
              </option>
            ))}
          </select>
        </label>
      ) : needsValue ? (
        <label className="flex flex-col gap-[6px] text-[14px] font-bold">
          New value
          <input
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={tried && !valueOk ? true : undefined}
            className={inputClass}
          />
        </label>
      ) : (
        <p className="text-[14px] leading-[20px]">
          The row is left out of the results and of scoring, as if the provider
          never listed it.
        </p>
      )}
      {tried && !valueOk ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          {what === "classification"
            ? "Pick the new status."
            : "Enter the new value as a number."}
        </p>
      ) : null}
      <ReasonField
        label="Reason (players see this)"
        value={reason}
        onChange={setReason}
        error={
          tried && !reasonReady(reason)
            ? STAFF_ERROR_WORDS.reason_required
            : undefined
        }
      />
      {row ? (
        <p className="text-[14px] leading-[20px] text-ink-muted">
          Saving re-scores this session.{" "}
          {plural(owners, "team owns", "teams own")} {row.driver} or {row.team}.
        </p>
      ) : (
        <p className="text-[14px] leading-[20px] text-ink-muted">
          Saving re-scores this session.
        </p>
      )}
      <Answer sent={sent} />
      <Button
        type="submit"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Save correction
      </Button>
    </form>
  );
}
