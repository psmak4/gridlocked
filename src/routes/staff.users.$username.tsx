import { useState, type ReactNode } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trustWords } from "@/lib/settings-words";
import { privateHeaders } from "@/lib/private-headers";
import {
  banAccount,
  getUser,
  releaseTrustLock,
  restrictUser,
  saveTrustLevel,
  saveUserRole,
  unbanAccount,
  viewAsUser,
} from "@/server/staff";
import { STAFF_ERROR_WORDS, type StaffErrorCode } from "@/staff/errors";
import type { UserActionId } from "@/staff/users";
import { ROLE_WORDS } from "./staff.users";

/**
 * One user's panel (wave 5, M8 Task 12): their role, trust, restrictions,
 * recent actions and trust history, then one reason and the actions,
 * grouped as Account (admins only), Trust and Restrictions. "View the site
 * as them" starts the existing impersonation flow and goes home as them.
 */
export const Route = createFileRoute("/staff/users/$username")({
  loader: ({ params }) => getUser({ data: { username: params.username } }),
  head: () => ({ meta: [{ title: "User · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: UserPanel,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const panel =
  "flex min-w-0 flex-[2_1_360px] flex-col gap-space-4 rounded-radius-l border-2 border-ink p-space-5";
const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const labelClass =
  "flex min-w-0 flex-[1_1_160px] flex-col gap-[6px] text-[14px] font-bold";

const RESTRICTION_WORDS: Record<string, string> = {
  mute: "Muted",
  chat_ban: "Banned from chat",
  thread_ban: "Banned from a thread",
};
const ACTION_WORDS: Record<string, string> = {
  remove: "Removed",
  restore: "Kept",
  lock: "Locked",
  retitle: "Retitled",
  warn: "Warned",
  mute: "Muted",
  unmute: "Mute lifted",
  chat_ban: "Banned from chat",
  chat_unban: "Chat ban lifted",
  ban: "Banned",
  unban: "Ban lifted",
};
const SOURCE_WORDS: Record<string, string> = {
  nightly: "nightly job",
  moderator: "staff",
  system: "system",
};

type Sent =
  { state: "idle" | "busy" } | { state: "done" | "error"; words: string };

type Answer = { ok: true } | { ok: false; error: StaffErrorCode };

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-space-3 border-0 border-t-2 border-line p-0 pt-space-3">
      <legend className={`${eyebrow} pb-space-2`}>{title}</legend>
      {children}
    </fieldset>
  );
}

function UserPanel() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const [role, setRole] = useState("");
  const [banDays, setBanDays] = useState("7");
  const [level, setLevel] = useState("");
  const [hours, setHours] = useState("24");

  if (!result.ok) {
    return (
      <section className={panel}>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {result.error === "not_found"
            ? "Nobody has that username."
            : STAFF_ERROR_WORDS[result.error]}
        </p>
      </section>
    );
  }
  const user = result.value;
  const has = (id: UserActionId) => user.actions.some((a) => a.id === id);
  const label = (id: UserActionId) =>
    user.actions.find((a) => a.id === id)?.label ?? id;
  const groups = new Set(user.actions.map((a) => a.group));
  const trust = trustWords(user.trust.level).name;
  const busy = sent.state === "busy";

  const run = async (
    id: UserActionId,
    call: () => Promise<Answer>,
    after?: () => void,
  ) => {
    setTried(true);
    if (!reasonReady(reason)) return;
    setSent({ state: "busy" });
    const answer = await call();
    if (answer.ok) {
      if (after) return after();
      setSent({ state: "done", words: `${label(id)}: done.` });
      setReason("");
      setTried(false);
    } else {
      setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    }
    await router.invalidate();
  };

  const roleChoice = role || user.role;
  const levelChoice = level === "" ? String(user.trust.level) : level;

  return (
    <section
      aria-labelledby="user-heading"
      key={user.userId}
      data-slot="user-panel"
      className={panel}
    >
      <div className="flex flex-col gap-space-1">
        <span className={eyebrow}>
          {(ROLE_WORDS[user.role] ?? user.role).toUpperCase()} · JOINED{" "}
          {user.joined.toUpperCase()}
        </span>
        <h2
          id="user-heading"
          className="m-0 font-display text-[24px] leading-[28px] font-normal break-words uppercase"
        >
          {user.username ?? "Deleted account"}
        </h2>
        <span className="flex flex-wrap items-center gap-space-2">
          {user.deleted ? <Badge>Deleted</Badge> : null}
          {user.ban ? (
            <Badge tone="caution">
              {user.ban.untilLabel
                ? `Banned until ${user.ban.untilLabel}`
                : "Banned"}
            </Badge>
          ) : null}
          {user.restrictions.map((r) => (
            <Badge key={r.kind} tone="caution">
              {RESTRICTION_WORDS[r.kind] ?? r.kind}
              {r.untilLabel ? ` until ${r.untilLabel}` : ""}
            </Badge>
          ))}
        </span>
      </div>

      {user.deleted ? (
        <p className="text-[16px]">
          This account was deleted. Its name stays held for 90 days, and nothing
          here can be changed.
        </p>
      ) : (
        <p data-slot="user-trust" className="text-[16px]">
          Trust: <span className="font-bold">{trust}</span>
          {user.trust.locked
            ? " · locked (the nightly job leaves it)"
            : " · set by the nightly job"}
        </p>
      )}

      {user.recent.length > 0 ? (
        <div className="flex flex-col gap-space-2">
          <h3 className={eyebrow}>RECENT ACTIONS</h3>
          <ul className="m-0 flex list-none flex-col gap-space-1 p-0 text-[14px]">
            {user.recent.map((a) => (
              <li key={`${a.createdAt}-${a.action}`}>
                <span className="font-bold">
                  {ACTION_WORDS[a.action] ?? a.action}
                </span>
                {a.untilLabel ? ` until ${a.untilLabel}` : ""} · {a.atLabel} · “
                {a.reason}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {user.trustHistory.length > 0 ? (
        <div className="flex flex-col gap-space-2">
          <h3 className={eyebrow}>TRUST HISTORY</h3>
          <ul className="m-0 flex list-none flex-col gap-space-1 p-0 text-[14px]">
            {user.trustHistory.map((h, i) => (
              <li key={i}>
                {trustWords(h.from).name} → {trustWords(h.to).name} · by the{" "}
                {SOURCE_WORDS[h.source] ?? h.source} · {h.atLabel}
                {h.reason ? ` · “${h.reason}”` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sent.state === "error" ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          {sent.words}
        </p>
      ) : sent.state === "done" ? (
        <p role="status" className="text-[14px]">
          {sent.words}
        </p>
      ) : null}

      {user.actions.length > 0 ? (
        <form
          aria-label="Change this user"
          onSubmit={(e) => e.preventDefault()}
          noValidate
          className="flex flex-col gap-space-4"
        >
          <ReasonField
            value={reason}
            onChange={setReason}
            error={
              tried && !reasonReady(reason)
                ? STAFF_ERROR_WORDS.reason_required
                : undefined
            }
          />

          {groups.has("account") ? (
            <Group title="ACCOUNT">
              <div className="flex flex-wrap items-end gap-space-3">
                <label className={labelClass}>
                  Role
                  <select
                    value={roleChoice}
                    onChange={(e) => setRole(e.target.value)}
                    className={inputClass}
                  >
                    <option value="user">User</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <Button
                  type="button"
                  disabled={busy || roleChoice === user.role}
                  onClick={() =>
                    void run("set_role", () =>
                      saveUserRole({
                        data: {
                          userId: user.userId,
                          role: roleChoice as "user",
                          reason,
                        },
                      }),
                    )
                  }
                >
                  {label("set_role")}
                </Button>
              </div>
              {has("ban") ? (
                <div className="flex flex-wrap items-end gap-space-3">
                  <label className={labelClass}>
                    Ban for
                    <select
                      value={banDays}
                      onChange={(e) => setBanDays(e.target.value)}
                      className={inputClass}
                    >
                      <option value="1">1 day</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                      <option value="none">Until lifted</option>
                    </select>
                  </label>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run("ban", () =>
                        banAccount({
                          data: {
                            userId: user.userId,
                            days: banDays === "none" ? null : Number(banDays),
                            reason,
                          },
                        }),
                      )
                    }
                  >
                    {label("ban")}
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-space-3">
                {has("unban") ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run("unban", () =>
                        unbanAccount({ data: { userId: user.userId, reason } }),
                      )
                    }
                  >
                    {label("unban")}
                  </Button>
                ) : null}
                {has("impersonate") ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        "impersonate",
                        () =>
                          viewAsUser({ data: { userId: user.userId, reason } }),
                        () => window.location.assign("/"),
                      )
                    }
                  >
                    {label("impersonate")}
                  </Button>
                ) : null}
              </div>
            </Group>
          ) : null}

          {groups.has("trust") ? (
            <Group title="TRUST">
              <div className="flex flex-wrap items-end gap-space-3">
                <label className={labelClass}>
                  Trust level
                  <select
                    value={levelChoice}
                    onChange={(e) => setLevel(e.target.value)}
                    className={inputClass}
                  >
                    {[0, 1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {trustWords(n).name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run("set_trust", () =>
                      saveTrustLevel({
                        data: {
                          userId: user.userId,
                          level: Number(levelChoice) as 0,
                          reason,
                        },
                      }),
                    )
                  }
                >
                  {label("set_trust")}
                </Button>
              </div>
              {has("clear_trust_lock") ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="self-start"
                  disabled={busy}
                  onClick={() =>
                    void run("clear_trust_lock", () =>
                      releaseTrustLock({
                        data: { userId: user.userId, reason },
                      }),
                    )
                  }
                >
                  {label("clear_trust_lock")}
                </Button>
              ) : null}
            </Group>
          ) : null}

          {groups.has("restrictions") ? (
            <Group title="RESTRICTIONS">
              {has("mute") || has("chat_ban") ? (
                <label className={`${labelClass} max-w-[240px]`}>
                  For
                  <select
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    className={inputClass}
                  >
                    <option value="24">24 hours</option>
                    <option value="168">7 days</option>
                    <option value="720">30 days</option>
                    <option value="none">Until lifted</option>
                  </select>
                </label>
              ) : null}
              <div className="flex flex-wrap gap-space-3">
                {(["warn", "mute", "unmute", "chat_ban", "chat_unban"] as const)
                  .filter(has)
                  .map((id) => (
                    <Button
                      key={id}
                      type="button"
                      variant={id.includes("un") ? "secondary" : "primary"}
                      disabled={busy}
                      onClick={() =>
                        void run(id, () =>
                          restrictUser({
                            data: {
                              userId: user.userId,
                              action: id,
                              reason,
                              ...((id === "mute" || id === "chat_ban") &&
                              hours !== "none"
                                ? { hours: Number(hours) }
                                : {}),
                            },
                          }),
                        )
                      }
                    >
                      {label(id)}
                    </Button>
                  ))}
              </div>
            </Group>
          ) : null}
        </form>
      ) : null}

      <Link
        to="/staff/users"
        search={{ q: "" }}
        className="flex min-h-[44px] items-center self-start text-[16px] text-ink underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring lg:hidden"
      >
        Back to the search
      </Link>
    </section>
  );
}
