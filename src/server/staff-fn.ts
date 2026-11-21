/**
 * The one way a staff screen reaches the server (M8 Task 3). `staffFn` is the
 * handler of every staff server function, and, in order:
 *
 * 1. marks the answer `private, no-store`;
 * 2. reads the viewer and runs `requireStaff` at the function's role, so an
 *    unverified, impersonated or demoted session is refused before its input
 *    is even parsed (the route guard is for the screen; this is the guard
 *    that counts);
 * 3. checks the input with Zod;
 * 4. resolves the request's "now" once and gives the call a request id;
 * 5. answers `{ ok: true, value }`, or `{ ok: false, error }` with a
 *    `StaffErrorCode`. Anything else becomes `server_error`, logged by its
 *    class name only, as `server-fn-errors.ts` does.
 */
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import type { z } from "zod";
import type { Db } from "@/db/types";
import { requireStaff } from "@/identity/staff-roles";
import { IdentityError, type Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import {
  isStaffErrorCode,
  StaffError,
  type StaffErrorCode,
  type StaffResult,
} from "@/staff/errors";
import type { StaffActor } from "@/staff/roster";
import { getViewer, withRequestNow } from "./session";

/** What a staff handler gets: the request's database, "now", viewer and id. */
export type StaffContext = {
  db: Db;
  now: Date;
  viewer: Viewer;
  /** Ties the audit rows of one call together: `web:<uuid>`. */
  requestId: string;
};

export type StaffFnDef<I, T> = {
  role: "moderator" | "admin";
  input: z.ZodType<I>;
  handler: (ctx: StaffContext, input: I) => Promise<T>;
};

/** Runs `fn` with the request's database and "now". */
export type RunWithDb = <T>(
  fn: (db: Db, now: Date) => Promise<T>,
) => Promise<T>;

function refusal(error: unknown): StaffErrorCode {
  if (
    (error instanceof IdentityError || error instanceof StaffError) &&
    isStaffErrorCode(error.code)
  ) {
    return error.code;
  }
  const name =
    error instanceof Error
      ? error.name !== "Error"
        ? error.name
        : error.constructor?.name || "Error"
      : typeof error;
  const code = error instanceof IdentityError ? ` (${error.code})` : "";
  console.error(`staff function failed: ${name}${code}`);
  return "server_error";
}

/** `staffFn`'s work, apart from the Start runtime so it can be tested. */
export async function runStaff<I, T>(
  def: StaffFnDef<I, T>,
  viewer: Viewer | null,
  data: unknown,
  run: RunWithDb,
): Promise<StaffResult<T>> {
  let staff: Viewer;
  try {
    staff = requireStaff(viewer, def.role);
  } catch (error) {
    return { ok: false, error: refusal(error) };
  }
  const parsed = def.input.safeParse(data);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const value = await run((db, now) =>
      def.handler(
        { db, now, viewer: staff, requestId: `web:${newId()}` },
        parsed.data,
      ),
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: refusal(error) };
  }
}

/** The validator a staff server function uses: none, so the guard comes first. */
export const staffInput = (data: unknown): unknown => data;

/**
 * The handler of a staff server function. Each function is still written out
 * where it's declared, since Start's compiler names a server function by the
 * place `createServerFn` is called:
 *
 *     export const getAudit = createServerFn({ method: "GET" })
 *       .validator(staffInput)
 *       .handler(staffFn({ role: "admin", input, handler }));
 */
export function staffFn<I, T>(def: StaffFnDef<I, T>) {
  return async ({ data }: { data: unknown }): Promise<StaffResult<T>> => {
    setResponseHeader("Cache-Control", "private, no-store");
    const viewer = await getViewer(getRequest());
    return runStaff(def, viewer, data, (fn) => withRequestNow(fn));
  };
}

/** Who a staff write's audit rows name: the signed-in admin, by this call. */
export function staffActor(viewer: Viewer, requestId: string): StaffActor {
  return { kind: "admin", label: null, userId: viewer.userId, requestId };
}
