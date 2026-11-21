/**
 * Every action the audit log records (DM 6.6, M8 Task 4), with the words the
 * audit screen shows and the filter it falls under. `writeAudit` takes only
 * these, so an action the screen can't name doesn't compile. No imports, so
 * the screen can load it too.
 */

export const AUDIT_GROUPS = {
  results: "Results and scoring",
  moderation: "Moderation",
  season: "Season data",
  security: "Security",
  settings: "Settings",
} as const;
export type AuditGroup = keyof typeof AUDIT_GROUPS;

export const AUDIT_ACTIONS = {
  // Results and scoring.
  "result_override.create": { label: "Result corrected", group: "results" },
  "result_override.revoke": {
    label: "Correction revoked",
    group: "results",
  },
  "game.dry_run": { label: "Scoring dry run", group: "results" },
  "game.rescore_approved": { label: "Re-score approved", group: "results" },
  "ruleset_version.correct": { label: "Ruleset corrected", group: "results" },
  "game_session_exception.set": {
    label: "Session left out of scoring",
    group: "results",
  },
  "game_session_exception.clear": {
    label: "Session back in scoring",
    group: "results",
  },

  // Moderation: `moderate` writes `moderation.<action>`.
  "moderation.remove": { label: "Content removed", group: "moderation" },
  "moderation.restore": { label: "Content restored", group: "moderation" },
  "moderation.lock": { label: "Thread locked", group: "moderation" },
  "moderation.unlock": { label: "Thread unlocked", group: "moderation" },
  "moderation.pin": { label: "Thread pinned", group: "moderation" },
  "moderation.unpin": { label: "Thread unpinned", group: "moderation" },
  "moderation.move": { label: "Thread moved", group: "moderation" },
  "moderation.retitle": { label: "Thread retitled", group: "moderation" },
  "moderation.warn": { label: "Warning", group: "moderation" },
  "moderation.mute": { label: "Mute", group: "moderation" },
  "moderation.unmute": { label: "Mute lifted", group: "moderation" },
  "moderation.chat_ban": { label: "Chat ban", group: "moderation" },
  "moderation.chat_unban": { label: "Chat ban lifted", group: "moderation" },
  "user.ban": { label: "User banned", group: "moderation" },
  "user.unban": { label: "Ban lifted", group: "moderation" },
  "user.trust_level.set": { label: "Trust level set", group: "moderation" },
  "user.trust_level.unlock": {
    label: "Trust level back to automatic",
    group: "moderation",
  },

  // Season data.
  "seat_assignment.open": { label: "Seat change", group: "season" },
  "seat_assignment.close": { label: "Seat ended", group: "season" },
  "event_entry.create": { label: "Entry added", group: "season" },
  "event_entry.update": { label: "Entry changed", group: "season" },
  "driver_availability.update": {
    label: "Availability change",
    group: "season",
  },
  "pool_asset.create": { label: "Asset added to the game", group: "season" },
  "pool_asset.withdraw": { label: "Asset withdrawn", group: "season" },
  "asset_price.set": { label: "Price set", group: "season" },
  "event.lock_at.update": { label: "Lock time change", group: "season" },
  "event.cancel": { label: "Event cancelled", group: "season" },
  "session.times.update": { label: "Session times change", group: "season" },
  "session.status.update": { label: "Session status change", group: "season" },

  // Security: staff access, roles and accounts.
  "staff.session.verify": { label: "Staff tools unlocked", group: "security" },
  "staff.session.verify_failed": {
    label: "Staff code refused",
    group: "security",
  },
  "staff.session.verify_locked": {
    label: "Staff unlock locked out",
    group: "security",
  },
  "user.role.update": { label: "Role change", group: "security" },
  "user.impersonate.start": {
    label: "Impersonation started",
    group: "security",
  },
  "user.impersonate.stop": { label: "Impersonation ended", group: "security" },
  "user.email.update": { label: "Email changed", group: "security" },
  "user.password.update": { label: "Password changed", group: "security" },
  "user.sign_in_method.remove": {
    label: "Sign-in method removed",
    group: "security",
  },
  "user.accounts.revoke_unproven": {
    label: "Unproven sign-in removed",
    group: "security",
  },
  "user.purge_incomplete": {
    label: "Unfinished sign-up removed",
    group: "security",
  },
  "user.delete": { label: "Account deleted", group: "security" },
} as const satisfies Record<string, { label: string; group: AuditGroup }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** The actions in one filter group. */
export function actionsIn(group: AuditGroup): AuditAction[] {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
    (action) => AUDIT_ACTIONS[action].group === group,
  );
}
