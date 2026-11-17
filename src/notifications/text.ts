/**
 * The words of a notification (wave 4's Notifications board). Pure, and
 * decided when it's shown: a row stores template values only (DM 5.11), and
 * anything tied to a session the reader hasn't revealed reads in its
 * spoiler-safe form. A push payload is always the safe form (Task 14).
 */
import type { BroadcastKind, NotificationKind } from "./kinds";

export type AnyNotificationKind = NotificationKind | BroadcastKind;

/** The stored values, plus what the reader adds: the count and the actor's name. */
export type NotificationData = {
  count?: number;
  actor?: string | null;
  title?: string;
  safeTitle?: string | null;
  driver?: string;
  status?: string;
  event?: string;
  team?: string;
  league?: string;
  leagueSlug?: string;
  hours?: number;
  delta?: number;
  action?: string;
  until?: string | null;
  session?: string;
  sessionKind?: string;
  leader?: string | null;
  text?: string;
};

export type NotificationLine = { label: string; text: string };

const LABELS: Record<AnyNotificationKind, string> = {
  reply: "REPLIES",
  mention: "MENTION",
  roster_change: "YOUR TEAM",
  lock_reminder: "LOCK",
  league_activity: "LEAGUES",
  score_correction: "CORRECTION",
  moderation: "MODERATION",
  scores_in: "SCORES",
  announcement: "NEWS",
};

const dateWords = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const signed = (n: number) =>
  n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";

/** Pole for a qualifying session, a win for a race. */
const leaderVerb = (sessionKind: string | undefined) =>
  sessionKind === "qualifying" || sessionKind === "sprint_qualifying"
    ? "took pole"
    : "won";

function moderationText(d: NotificationData): string {
  switch (d.action) {
    case "remove":
      return "A moderator removed one of your posts. Tap to see why.";
    case "restore":
      return "A moderator restored one of your posts.";
    case "warn":
      return "A moderator sent you a warning. Tap to see why.";
    case "mute":
      return d.until
        ? `A moderator muted you until ${dateWords.format(Date.parse(d.until))}. Tap to see why.`
        : "A moderator muted you. Tap to see why.";
    case "chat_ban":
      return d.until
        ? `You can't use live chat until ${dateWords.format(Date.parse(d.until))}. Tap to see why.`
        : "You can't use live chat for now. Tap to see why.";
    case "unmute":
      return "You can post again.";
    default:
      return "A moderator took an action on your account. Tap to see why.";
  }
}

/**
 * The label and text for one notification. `revealed` is false while the
 * notification's session is hidden from the reader.
 */
export function notificationText(
  kind: AnyNotificationKind,
  d: NotificationData,
  revealed: boolean,
): NotificationLine {
  const label = LABELS[kind];
  const title = !revealed && d.safeTitle ? d.safeTitle : (d.title ?? "");
  const actor = d.actor ?? "Someone";
  const count = d.count ?? 1;
  switch (kind) {
    case "reply":
      return {
        label,
        text:
          count > 1
            ? `${count} new replies in “${title}”`
            : `${actor} replied in “${title}”`,
      };
    case "mention":
      return { label, text: `${actor} mentioned you in “${title}”` };
    case "roster_change":
      return {
        label,
        text: `${d.driver} is ${d.status === "unavailable" ? "out" : "doubtful"} for ${d.event}. Check ${d.team}.`,
      };
    case "lock_reminder":
      return {
        label,
        text: `${d.event} locks in ${d.hours === 1 ? "1 hour" : `${d.hours ?? 24} hours`}. Check your team.`,
      };
    case "league_activity":
      return { label, text: `${d.team} joined ${d.league}.` };
    case "score_correction":
      return {
        label,
        text: revealed
          ? `Your ${d.event} score changed by ${signed(d.delta ?? 0)} after a correction.`
          : `Your ${d.event} score was corrected.`,
      };
    case "moderation":
      return { label, text: moderationText(d) };
    case "scores_in": {
      const session = d.session ?? "Session";
      if (!revealed) {
        return { label, text: `${session} results are in for the ${d.event}.` };
      }
      return {
        label,
        text: d.leader
          ? `${d.event} ${session.toLowerCase()}: ${d.leader} ${leaderVerb(d.sessionKind)}. Scores are in.`
          : `${d.event}: ${session.toLowerCase()} scores are in.`,
      };
    }
    case "announcement":
      return { label, text: d.text ?? "" };
  }
}
