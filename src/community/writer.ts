/**
 * What the viewer may do on the forum's screens, as the server worked it
 * out. No database here: the screens import it.
 */
export type Writer = {
  /** Staff count as 3. */
  trustLevel: number;
  /** Verified, active and not read-only: may reply and vote. */
  canPost: boolean;
} | null;

/** May start a thread in a category with this minimum trust level. */
export const canStartIn = (writer: Writer, minTrust: number) =>
  writer !== null && writer.canPost && writer.trustLevel >= minTrust;
