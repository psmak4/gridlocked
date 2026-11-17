// The notification lists (DM 5.11), with no database code, so the screens
// can import them; the schema re-exports them.

/** Personal notifications: one person's inbox. */
export const NOTIFICATION_KINDS = [
  "reply",
  "mention",
  "roster_change",
  "lock_reminder",
  "league_activity",
  "score_correction",
  "moderation",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Messages for everyone: one row, merged into every bell. */
export const BROADCAST_KINDS = ["scores_in", "announcement"] as const;
export type BroadcastKind = (typeof BROADCAST_KINDS)[number];

export const NOTIFICATION_CHANNELS = ["in_app", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
