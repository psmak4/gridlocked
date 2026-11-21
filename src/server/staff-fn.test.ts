import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  PASSWORD,
  recordingSender,
  TEST_NOW,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import {
  enableTotp,
  signUpAs,
  totpCode,
  viewerFor,
} from "../../tests/helpers/staff";
import type { Db } from "@/db/types";
import { verifyStaffSession } from "@/identity/staff-access";
import { IdentityError, type Viewer } from "@/identity/viewer";
import { StaffError } from "@/staff/errors";
import { runStaff, type StaffFnDef } from "./staff-fn";

describe("staffFn (M8 Task 3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  const now = () => new Date();
  /** The request's database and "now", as `withRequestNow` gives them. */
  const deps =
    () =>
    <T>(fn: (db: Db, now: Date) => Promise<T>) =>
      fn(t.db as unknown as Db, now());

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
    t = await createTestDb();
    auth = testAuth(t.db, { now, sender: recordingSender().sender });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await t.close();
  });

  /** A staff member with TOTP on, their session unlocked or not. */
  const staff = async (
    role: "admin" | "moderator",
    unlocked: boolean,
  ): Promise<Viewer> => {
    const signedUp = await signUpAs(auth, t.db, `${role}@example.test`, role);
    const { secret, cookie } = await enableTotp(auth, signedUp.cookie, {
      password: PASSWORD,
    });
    if (unlocked) {
      await verifyStaffSession(auth, t.db, now(), {
        viewer: (await viewerFor(t.db, cookie, now))!,
        code: await totpCode(auth, secret),
      });
    }
    return (await viewerFor(t.db, cookie, now))!;
  };

  const echo = (
    handler: StaffFnDef<{ name: string }, string>["handler"] = async (
      ctx,
      input,
    ) => `${input.name} by ${ctx.viewer.userId} at ${ctx.now.toISOString()}`,
  ) => {
    const def: StaffFnDef<{ name: string }, string> = {
      role: "admin",
      input: z.strictObject({ name: z.string().min(1) }),
      handler: vi.fn(handler),
    };
    return def;
  };

  it("staffFn refuses an unverified session before parsing the input", async () => {
    const def = echo();
    const locked = await staff("admin", false);
    expect(await runStaff(def, locked, { nonsense: true }, deps())).toEqual({
      ok: false,
      error: "staff_session_unverified",
    });
    expect(await runStaff(def, null, { nonsense: true }, deps())).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(def.handler).not.toHaveBeenCalled();

    // Unlocked, the same input is then refused as input.
    const open = await staff("moderator", true);
    const modDef = { ...def, role: "moderator" as const };
    expect(await runStaff(modDef, open, { nonsense: true }, deps())).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await runStaff(modDef, open, { name: "Ada" }, deps())).toEqual({
      ok: true,
      value: `Ada by ${open.userId} at ${now().toISOString()}`,
    });
  });

  it("staffFn refuses an impersonated admin and a moderator at an admin function", async () => {
    const def = echo();
    const admin = await staff("admin", true);
    expect(
      await runStaff(
        def,
        { ...admin, impersonatedBy: admin.userId },
        { name: "Ada" },
        deps(),
      ),
    ).toEqual({ ok: false, error: "read_only" });
    const moderator = await staff("moderator", true);
    expect(await runStaff(def, moderator, { name: "Ada" }, deps())).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(def.handler).not.toHaveBeenCalled();
  });

  it("staffFn turns an IdentityError into its code and any other error into server_error", async () => {
    const admin = await staff("admin", true);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    expect(
      await runStaff(
        echo(async () => {
          throw new IdentityError("reason_required");
        }),
        admin,
        { name: "Ada" },
        deps(),
      ),
    ).toEqual({ ok: false, error: "reason_required" });
    // A code no staff screen has words for is a server error too.
    expect(
      await runStaff(
        echo(async () => {
          throw new IdentityError("username_too_soon");
        }),
        admin,
        { name: "Ada" },
        deps(),
      ),
    ).toEqual({ ok: false, error: "server_error" });
    expect(
      await runStaff(
        echo(async () => {
          throw new StaffError("stale");
        }),
        admin,
        { name: "Ada" },
        deps(),
      ),
    ).toEqual({ ok: false, error: "stale" });
    expect(
      await runStaff(
        echo(async () => {
          throw new Error("duplicate key: ada@example.test");
        }),
        admin,
        { name: "Ada" },
        deps(),
      ),
    ).toEqual({ ok: false, error: "server_error" });
    // Logged by name, never the message.
    expect(logged.join("\n")).not.toContain("ada@example.test");
    expect(logged.join("\n")).toContain("staff function failed: Error");
  });

  it("each call gets its own request id", async () => {
    const admin = await staff("admin", true);
    const ids: string[] = [];
    const def = echo(async (ctx) => {
      ids.push(ctx.requestId);
      return "ok";
    });
    await runStaff(def, admin, { name: "Ada" }, deps());
    await runStaff(def, admin, { name: "Ada" }, deps());
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^web:/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
