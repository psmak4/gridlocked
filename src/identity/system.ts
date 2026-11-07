/**
 * The reserved `system` user (DM 6.1): the author of results posts and auto
 * threads, and the actor on rows made by staff tooling. It has no sign-in
 * accounts and can never sign in. The `identity_rules` migration creates the
 * row, so any column that points at a user can point at this one.
 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
