import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getStaffSettings, saveStaffSettings } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * Settings (wave 5's settings board, M8 Task 13): the chat and push
 * switches, notification emails and ads shown locked with why, free-tier
 * usage (Task 14), and the results pipeline's timings. One reason and one
 * Save for the lot; each key that changed gets its own audit row.
 */
export const Route = createFileRoute("/staff/settings")({
  loader: () => getStaffSettings({ data: {} }),
  head: () => ({ meta: [{ title: "Settings · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: SettingsScreen,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-invalid:border-fall";
const labelClass =
  "flex min-w-0 flex-[1_1_200px] flex-col gap-[6px] text-[14px] font-bold";
const section =
  "flex flex-col gap-space-3 rounded-radius-l bg-surface-raised p-space-4";

type Data = Extract<
  Awaited<ReturnType<typeof getStaffSettings>>,
  { ok: true }
>["value"];

/** "5, 15, 60" → [5, 15, 60]; null if any part isn't a whole number over 0. */
function minutesList(text: string): number[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const numbers = parts.map(Number);
  return numbers.every((n) => Number.isInteger(n) && n > 0) ? numbers : null;
}

function LockedRow({ label, why }: { label: string; why: string }) {
  return (
    <div
      data-slot="locked-feature"
      className="flex min-h-[48px] items-start justify-between gap-space-3"
    >
      <div className="flex flex-col gap-[2px]">
        <span className="text-[16px] font-bold">{label}</span>
        <span className="text-[14px] text-ink-muted">{why}</span>
      </div>
      <Badge>Off · locked</Badge>
    </div>
  );
}

function SettingsScreen() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <p role="alert" className="text-[16px] font-semibold text-fall">
        {STAFF_ERROR_WORDS[result.error]}
      </p>
    );
  }
  return <SettingsForm data={result.value} />;
}

function SettingsForm({ data }: { data: Data }) {
  const router = useRouter();
  const [chat, setChat] = useState(data.flags.chat);
  const [push, setPush] = useState(data.flags.push);
  const [first, setFirst] = useState(String(data.poll.backoffMinutes[0]));
  const [then, setThen] = useState(
    data.poll.backoffMinutes.slice(1).join(", "),
  );
  const [giveUp, setGiveUp] = useState(String(data.poll.giveUpAfterHours));
  const [recheck, setRecheck] = useState(data.finalizer.afterHours.join(", "));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<
    { state: "idle" | "busy" } | { state: "done" | "error"; words: string }
  >({ state: "idle" });

  const firstMin = minutesList(first);
  const thenMin = minutesList(then);
  const giveUpHours = minutesList(giveUp);
  const recheckHours = minutesList(recheck);
  const bad = {
    first: !firstMin || firstMin.length !== 1,
    then: !thenMin,
    giveUp: !giveUpHours || giveUpHours.length !== 1,
    recheck: !recheckHours || recheckHours.length === 0,
  };

  const save = async () => {
    setTried(true);
    if (!reasonReady(reason) || Object.values(bad).some(Boolean)) return;
    setSent({ state: "busy" });
    const answer = await saveStaffSettings({
      data: {
        reason,
        values: {
          feature_flags: { chat, push },
          poll_schedule: {
            backoffMinutes: [...firstMin!, ...thenMin!],
            giveUpAfterHours: giveUpHours![0]!,
          },
          finalizer_checks: { afterHours: recheckHours! },
        },
      },
    });
    if (answer.ok) {
      setSent({
        state: "done",
        words:
          answer.value.changed.length === 0
            ? "Nothing changed."
            : "Saved. It's in the audit log.",
      });
      setReason("");
      setTried(false);
    } else {
      setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    }
    await router.invalidate();
  };

  const fieldError = (wrong: boolean, words: string) =>
    tried && wrong ? (
      <span className="text-[14px] font-semibold text-fall">{words}</span>
    ) : null;

  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>SETTINGS AND HISTORY</span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Settings
        </h1>
        <p className="max-w-[760px] text-[16px] text-ink-muted">
          Admins only. Every change goes in the audit log.
        </p>
      </header>

      <form
        aria-label="Settings"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex max-w-[760px] flex-col gap-space-5"
      >
        <section aria-labelledby="features" className={section}>
          <h2 id="features" className={eyebrow}>
            FEATURES
          </h2>
          <Switch
            id="flag-chat"
            label="Live chat"
            description="Off: session threads stay discussions, and nobody can chat."
            checked={chat}
            onChange={setChat}
          />
          <Switch
            id="flag-push"
            label="Push notifications"
            description="Off: nothing is pushed. In-app notifications still arrive."
            checked={push}
            onChange={setPush}
          />
          <LockedRow
            label="Notification emails"
            why="Off until we're on a paid email plan: the free plan's 100 emails a day are kept for sign-in and account emails."
          />
          <LockedRow
            label="Ads"
            why="Off: Gridlocked is non-commercial until the data licences allow advertising."
          />
        </section>

        <section aria-labelledby="usage" className={section}>
          <h2 id="usage" className={eyebrow}>
            FREE-TIER USAGE
          </h2>
          <p className="text-[14px] text-ink-muted">
            This month so far, read once a day. Each warns at 70% of its free
            limit.
          </p>
          <ul className="m-0 flex list-none flex-col gap-space-3 p-0">
            {data.meters.map((m) => (
              <li
                key={m.label}
                data-slot="usage-meter"
                className="flex flex-col gap-space-1"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-space-2">
                  <span className="text-[16px] font-bold">{m.label}</span>
                  <span className="text-[14px]">{m.value ?? "—"}</span>
                </span>
                {m.pct !== null ? (
                  <span
                    role="meter"
                    aria-label={m.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(m.pct, 100)}
                    aria-valuetext={`${m.pct}%`}
                    className="block h-[8px] overflow-hidden rounded-radius-pill bg-surface-sunken"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-radius-pill",
                        m.warn ? "bg-caution" : "bg-ink",
                      )}
                      style={{ width: `${Math.min(m.pct, 100)}%` }}
                    />
                  </span>
                ) : null}
                <span
                  className={cn(
                    "text-[14px]",
                    m.warn ? "font-semibold text-caution" : "text-ink-muted",
                  )}
                >
                  {m.note}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="pipeline" className={section}>
          <h2 id="pipeline" className={eyebrow}>
            RESULTS PIPELINE
          </h2>
          <p className="text-[14px] text-ink-muted">
            After a session&apos;s scheduled end, results are checked, then
            checked again at each gap until they arrive or it&apos;s time to
            give up and alert an admin.
          </p>
          <div className="flex flex-wrap gap-space-3">
            <label className={labelClass}>
              First check (min)
              <input
                inputMode="numeric"
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                aria-invalid={tried && bad.first ? true : undefined}
                className={inputClass}
              />
              {fieldError(bad.first, "One whole number of minutes.")}
            </label>
            <label className={labelClass}>
              Then (min)
              <input
                value={then}
                onChange={(e) => setThen(e.target.value)}
                aria-invalid={tried && bad.then ? true : undefined}
                className={inputClass}
              />
              {fieldError(bad.then, "Whole numbers of minutes, with commas.")}
            </label>
          </div>
          <div className="flex flex-wrap gap-space-3">
            <label className={labelClass}>
              Give up and alert after (hours)
              <input
                inputMode="numeric"
                value={giveUp}
                onChange={(e) => setGiveUp(e.target.value)}
                aria-invalid={tried && bad.giveUp ? true : undefined}
                className={inputClass}
              />
              {fieldError(bad.giveUp, "One whole number of hours.")}
            </label>
            <label className={labelClass}>
              Re-check after the race (hours)
              <input
                value={recheck}
                onChange={(e) => setRecheck(e.target.value)}
                aria-invalid={tried && bad.recheck ? true : undefined}
                className={inputClass}
              />
              {fieldError(
                bad.recheck,
                "At least one whole number of hours, with commas.",
              )}
            </label>
          </div>
        </section>

        <ReasonField
          value={reason}
          onChange={setReason}
          error={
            tried && !reasonReady(reason)
              ? STAFF_ERROR_WORDS.reason_required
              : undefined
          }
        />
        {sent.state === "error" ? (
          <p role="alert" className="text-[14px] font-semibold text-fall">
            {sent.words}
          </p>
        ) : sent.state === "done" ? (
          <p role="status" className="text-[14px]">
            {sent.words}
          </p>
        ) : null}
        <Button
          type="submit"
          className="self-start"
          disabled={sent.state === "busy"}
        >
          Save settings
        </Button>
      </form>
    </>
  );
}
