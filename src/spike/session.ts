/** Spike: the session, read on the server from this request's cookies. */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { withAuth } from "./auth";

export type SessionUser = { id: string; email: string; role: string | null };

export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    const headers = getRequestHeaders();
    const session = await withAuth((auth) => auth.api.getSession({ headers }));
    if (!session) return null;
    const { id, email, role } = session.user as typeof session.user & {
      role?: string | null;
    };
    return { id, email, role: role ?? null };
  },
);

/** Throws unless signed in; for server functions that write. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("not signed in");
  return user;
}

/** The admin plugin's role check, on one server function. */
export const adminCheck = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUser();
    return { admin: user.role === "admin" };
  },
);
