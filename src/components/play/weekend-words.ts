/**
 * The weekend hub's words (wave 3's "Session row states" and the wave 2
 * spoiler hub): what one session row says in each state, in the viewer's
 * time or the track's. Pure, so each is tested on its own.
 */
import type { WeekendSession } from "@/play/weekend";

/** "Friday", "Fri" and "19:30" for an instant in `timeZone` (UTC if it's unknown). */
export function dayAndTime(
  iso: string,
  timeZone: string,
): { day: string; short: string; time: string } {
  const at = new Date(iso);
  const format = (zone: string) => {
    const part = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone }).format(
        at,
      );
    return {
      day: part({ weekday: "long" }),
      short: part({ weekday: "short" }),
      time: part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    };
  };
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

export type RowBadge = {
  tone: "neutral" | "live" | "caution";
  label: string;
};

export type SessionRowWords = {
  badges: RowBadge[];
  sub: string;
  /** The right-hand side: a time, or a word ("TBC", "Hidden", …). */
  right: string;
  /** How the right-hand side reads: a number, a heat word or a muted one. */
  rightTone: "time" | "heat" | "muted";
  /** A cancelled session is a dashed row. */
  dashed: boolean;
  /** "Mark as watched" belongs on the row. */
  markWatched: boolean;
};

/**
 * One session row. Times are in `timeZone`. A scored session the signed-in
 * reader hasn't seen says "Hidden", with Mark as watched. A logged-out
 * visitor has no watched state (decision 3), and the hub shows no score.
 */
export function sessionRow(
  s: WeekendSession,
  ctx: { timeZone: string; signedIn: boolean },
): SessionRowWords {
  const { day, time } = dayAndTime(s.start, ctx.timeZone);
  const badges: RowBadge[] = [];
  if (s.locksTeam) badges.push({ tone: "neutral", label: "Locks team" });
  const row = (
    sub: string,
    right: string,
    rightTone: SessionRowWords["rightTone"],
    more: Partial<SessionRowWords> = {},
  ): SessionRowWords => ({
    badges,
    sub,
    right,
    rightTone,
    dashed: false,
    markWatched: false,
    ...more,
  });

  switch (s.state) {
    case "cancelled":
      return row(`${day} · no session this weekend`, "Cancelled", "muted", {
        dashed: true,
      });
    case "tbc":
      return row(`${day} · start time not confirmed yet`, "TBC", "time");
    case "scheduled":
      return row(
        s.locksTeam ? `${day} · your team locks at the start` : day,
        time,
        "time",
      );
    case "live":
      badges.push({ tone: "live", label: "Live" });
      return row(`${day} · on now`, time, "time");
    case "red_flag":
      badges.push({ tone: "caution", label: "Red flag" });
      return row(`${day} · stopped for now`, time, "time");
    case "ended":
    case "ended_early": {
      if (s.state === "ended_early") {
        badges.push({ tone: "neutral", label: "Ended early" });
      }
      const early =
        s.state === "ended_early"
          ? " · scored from the official classification"
          : "";
      if (s.counts && s.scored && ctx.signedIn && !s.revealed) {
        return row(
          "Results are in · hidden until you watch",
          "Hidden",
          "heat",
          {
            markWatched: true,
          },
        );
      }
      if (s.counts && s.scored) {
        return row(`${day} · results are in${early}`, "Ended", "muted");
      }
      return row(
        s.state === "ended_early" ? `${day} · stopped early` : day,
        "Ended",
        "muted",
      );
    }
  }
}

/**
 * The weekend's dates in `timeZone`, from its first session to its last:
 * "6–8 Mar", or "30 Oct – 1 Nov" across a month's end.
 */
export function weekendDates(
  sessions: { start: string }[],
  timeZone: string,
): string {
  if (sessions.length === 0) return "";
  const parts = (iso: string) => {
    const at = new Date(iso);
    const get = (zone: string) => {
      const f = new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: zone,
      }).formatToParts(at);
      return {
        day: f.find((p) => p.type === "day")!.value,
        month: f.find((p) => p.type === "month")!.value,
      };
    };
    try {
      return get(timeZone);
    } catch {
      return get("UTC");
    }
  };
  const first = parts(sessions[0]!.start);
  const last = parts(sessions[sessions.length - 1]!.start);
  if (first.month === last.month) {
    return first.day === last.day
      ? `${first.day} ${first.month}`
      : `${first.day}–${last.day} ${first.month}`;
  }
  return `${first.day} ${first.month} – ${last.day} ${last.month}`;
}

/** "1st", "2nd", "3rd", "11th", "212th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ??
        "th");
  return `${n.toLocaleString("en-GB")}${suffix}`;
}

/** The browser's IANA zone, else UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
