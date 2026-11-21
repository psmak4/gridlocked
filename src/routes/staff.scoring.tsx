import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import {
  approveScoring,
  discardScoring,
  getScoring,
  startScoringDryRun,
} from "@/server/staff";
import { STAFF_ERROR_WORDS, type StaffResult } from "@/staff/errors";

/**
 * Scoring (wave 5's dry run board, M8 Task 8): the game's latest dry run as
 * four tiles and the biggest changes, with **Discard** and **Approve and
 * re-score**; with none, **Start a dry run**. Below, the game's ruleset
 * versions, read-only: a correction is `pnpm staff correct-ruleset` for now
 * (decision 3). Nothing here changes points until an approval.
 */
export const Route = createFileRoute("/staff/scoring")({
  loader: () => getScoring({ data: {} }),
  head: () => ({ meta: [{ title: "Scoring · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: Scoring,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

type Board = Extract<
  Awaited<ReturnType<typeof getScoring>>,
  { ok: true }
>["value"];
type DryRun = NonNullable<Board["dryRun"]>;

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

const points = (n: number) => n.toLocaleString("en-GB");
const signed = (n: number) =>
  n < 0 ? `−${points(Math.abs(n))}` : `+${points(n)}`;

function Scoring() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Scoring
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const board = result.value;
  if (!board.game) {
    return (
      <>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Scoring
        </h1>
        <p className="text-[16px] text-ink-muted">
          There&apos;s no game yet, so there&apos;s nothing to score.
        </p>
      </>
    );
  }
  const { game, dryRun } = board;
  return (
    <>
      {dryRun && dryRun.state !== "approved" ? (
        <DryRunBoard gameId={game.id} dryRun={dryRun} />
      ) : (
        <StartDryRun gameId={game.id} gameName={game.name} approved={dryRun} />
      )}
      <Versions versions={board.versions} />
    </>
  );
}

function StartDryRun({
  gameId,
  gameName,
  approved,
}: {
  gameId: string;
  gameName: string;
  approved: DryRun | null;
}) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reasonReady(reason)) return;
    const ok = await run(() =>
      startScoringDryRun({ data: { gameId, reason } }),
    );
    if (ok) {
      setReason("");
      setTried(false);
    }
  };
  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>SCORING · {gameName.toUpperCase()}</span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Scoring
        </h1>
        {approved ? (
          <p role="status" className="text-[16px]">
            The last dry run was approved, and its re-score is queued.{" "}
            <span className="text-ink-muted">
              Started {approved.startedLabel} · engine {approved.engineVersion}
            </span>
          </p>
        ) : (
          <p className="text-[16px] text-ink-muted">No dry run is waiting.</p>
        )}
      </header>
      <form
        aria-labelledby="start-dry-run"
        onSubmit={submit}
        noValidate
        className="flex max-w-[640px] flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-4"
      >
        <h2 id="start-dry-run" className={eyebrow}>
          START A DRY RUN
        </h2>
        <p className="text-[14px] leading-[20px]">
          A dry run re-scores every scored session of the season with the
          current code and rules, and shows what would change. Nothing changes
          until you approve it.
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
        <Answer sent={sent} />
        <Button
          type="submit"
          disabled={sent.state === "busy"}
          className="self-start"
        >
          {sent.state === "busy" ? "Running the dry run…" : "Start a dry run"}
        </Button>
      </form>
    </>
  );
}

const COLUMNS = [
  "TEAM",
  "EVENTS",
  "SEASON NOW",
  "AFTER FIX",
  "CHANGE",
] as const;

/** A cell that shows its column's name beside it on a phone. */
const stacked =
  "py-[10px] max-sm:flex max-sm:items-center max-sm:gap-space-2 max-sm:py-[2px] max-sm:before:w-[104px] max-sm:before:text-[12px] max-sm:before:font-bold max-sm:before:tracking-[0.12em] max-sm:before:text-ink-muted max-sm:before:uppercase max-sm:before:content-[attr(data-label)] sm:px-space-2";

function DryRunBoard({ gameId, dryRun }: { gameId: string; dryRun: DryRun }) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const { sent, run } = useSave();
  const act = async (kind: "approve" | "discard") => {
    setTried(true);
    if (!reasonReady(reason)) return;
    await run(
      () =>
        kind === "approve"
          ? approveScoring({
              data: { gameId, dryRunId: dryRun.dryRunId, reason },
            })
          : discardScoring({ data: { gameId, reason } }),
      kind === "approve"
        ? "Approved. The re-score is queued."
        : "Dry run discarded. Nothing was re-scored.",
    );
  };
  const rounds = dryRun.events.map((e) => e.round);
  const running = dryRun.state === "running";

  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>
          SCORING · DRY RUN · NOTHING HAS CHANGED YET
        </span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Scoring dry run
        </h1>
        {dryRun.reason ? (
          <p className="max-w-[760px] text-[16px]">{dryRun.reason}</p>
        ) : null}
        <p className="text-[14px] text-ink-muted">
          Started {dryRun.startedLabel} · engine {dryRun.engineVersion} ·{" "}
          {dryRun.sessions} scored sessions
        </p>
      </header>

      {running ? (
        <p role="status" className="text-[16px]">
          This dry run is still scoring. Reload in a minute.
        </p>
      ) : (
        <>
          <ul
            aria-label="Dry run totals"
            className="m-0 grid list-none grid-cols-2 gap-space-3 p-0 lg:grid-cols-4"
          >
            {dryRun.tiles.map((tile) => (
              <li
                key={tile.label}
                data-slot="dry-run-tile"
                className="flex flex-col gap-space-1 rounded-radius-l bg-surface-raised p-space-4"
              >
                <span className={eyebrow}>{tile.label}</span>
                <span className="font-numeric text-[32px] leading-[36px] font-bold">
                  {tile.value}
                </span>
                <span className="text-[14px] text-ink-muted">{tile.sub}</span>
              </li>
            ))}
          </ul>

          <section
            aria-labelledby="biggest"
            className="flex flex-col gap-space-2"
          >
            <h2 id="biggest" className={eyebrow}>
              BIGGEST CHANGES
            </h2>
            {dryRun.rows.length === 0 ? (
              <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
                No team&apos;s points change.
              </p>
            ) : (
              <div className="rounded-radius-l bg-surface-raised">
                <table
                  aria-label="Biggest changes"
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
                            i >= 2 && "text-right",
                          )}
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dryRun.rows.map((r) => (
                      <tr
                        key={r.teamId}
                        data-slot="dry-run-row"
                        className="border-t border-line max-sm:flex max-sm:flex-col max-sm:px-space-4 max-sm:py-space-2"
                      >
                        <td className="py-[10px] font-bold max-sm:py-[2px] sm:px-space-4">
                          {r.team}
                        </td>
                        <td
                          data-label="Events"
                          className={cn(stacked, "text-ink-muted")}
                        >
                          {r.events}
                        </td>
                        <td
                          data-label="Season now"
                          className={cn(stacked, "font-numeric sm:text-right")}
                        >
                          {points(r.before)}
                        </td>
                        <td
                          data-label="After fix"
                          className={cn(stacked, "font-numeric sm:text-right")}
                        >
                          {points(r.after)}
                        </td>
                        <td
                          data-label="Change"
                          className={cn(
                            stacked,
                            "font-numeric font-bold sm:px-space-4 sm:text-right",
                            r.change < 0 ? "text-fall" : "text-rise",
                          )}
                        >
                          {signed(r.change)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <form
        aria-label="Approve or discard the dry run"
        onSubmit={(e) => {
          e.preventDefault();
          void act("approve");
        }}
        noValidate
        className="flex max-w-[760px] flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-4"
      >
        <p className="text-[16px] leading-[24px]">
          Approving re-scores the season&apos;s {dryRun.sessions} scored
          sessions.{" "}
          {rounds.length > 0
            ? `Points change in ${roundList(rounds)}.`
            : "No team's points change."}{" "}
          Prices aren&apos;t changed.
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
        <Answer sent={sent} />
        <div className="flex flex-wrap gap-space-3">
          <Button
            type="button"
            variant="secondary"
            disabled={sent.state === "busy"}
            onClick={() => void act("discard")}
          >
            Discard
          </Button>
          <Button type="submit" disabled={sent.state === "busy" || running}>
            Approve and re-score
          </Button>
        </div>
      </form>
    </>
  );
}

/** "round 6", or "rounds 6, 11 and 18". */
function roundList(rounds: number[]): string {
  if (rounds.length === 1) return `round ${rounds[0]}`;
  return `rounds ${rounds.slice(0, -1).join(", ")} and ${rounds.at(-1)}`;
}

function Versions({ versions }: { versions: Board["versions"] }) {
  return (
    <section
      aria-labelledby="ruleset-versions"
      className="flex max-w-[760px] flex-col gap-space-3"
    >
      <h2 id="ruleset-versions" className={eyebrow}>
        RULESET VERSIONS
      </h2>
      <p className="text-[14px] leading-[20px] text-ink-muted">
        Read-only. A correction to past events is the Staff action
        workflow&apos;s correct-ruleset for now.
      </p>
      <ul
        aria-label="Ruleset versions"
        className="m-0 flex list-none flex-col gap-space-2 p-0"
      >
        {versions.map((v) => (
          <li
            key={v.id}
            data-slot="ruleset-version"
            className="flex flex-col gap-space-1 rounded-radius-m bg-surface-raised px-space-4 py-space-3"
          >
            <div className="flex flex-wrap items-center gap-space-2">
              <span className="font-bold">Version {v.version}</span>
              {v.isCorrection ? <Badge tone="caution">Correction</Badge> : null}
            </div>
            <span className="text-[14px]">{v.notes}</span>
            <span className="text-[14px] text-ink-muted">
              {v.fromRound !== null ? `From round ${v.fromRound} · ` : ""}
              {v.rounds.length > 0
                ? `Used by ${v.rounds.length === 1 ? "round" : "rounds"} ${v.rounds.join(", ")}`
                : "Not used by any round now"}{" "}
              · published {v.publishedLabel}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
