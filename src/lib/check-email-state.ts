export type CheckKind = "verify" | "link" | "reset";

export type CheckEmailState = { email?: string; kind?: CheckKind };

/**
 * What the form that sent an email hands to "Check your email" through
 * history state, so the address never enters a URL. The router types history
 * state loosely, hence the cast on the way in and the check on the way out.
 */
export const checkEmailState = (email: string, kind: CheckKind) =>
  ({ email, kind }) as never;

export function readCheckEmailState(state: unknown): CheckEmailState {
  const s = (state ?? {}) as Record<string, unknown>;
  return {
    ...(typeof s.email === "string" ? { email: s.email } : {}),
    ...(s.kind === "verify" || s.kind === "link" || s.kind === "reset"
      ? { kind: s.kind }
      : {}),
  };
}
