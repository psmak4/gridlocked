import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import type { Db } from "@/db/types";
import { IdentityError, type Viewer } from "@/identity/viewer";

// The access matrix (M9 Task 9): every exported server function, called with
// no session and as a plain player. Start's runtime is stubbed so each
// function's handler runs on its own: `createServerFn` records the handler,
// the request is a same-origin POST, and the session module hands over the
// viewer under test and a test database. The handler is called with empty
// input and no validator, so it is the function's own guard that answers;
// in the real app the validator runs first, which only refuses sooner.

type Def = {
  method: string;
  handler: (ctx: { data: unknown }) => Promise<unknown>;
};

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  db: null as unknown,
  now: new Date("2026-03-01T12:00:00.000Z"),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    createServerFn: (options?: { method?: string }) => {
      const def: Partial<Def> = { method: options?.method ?? "GET" };
      const builder = {
        validator: () => builder,
        inputValidator: () => builder,
        middleware: () => builder,
        handler: (handler: Def["handler"]) => {
          def.handler = handler;
          return Object.assign(
            () => Promise.reject(new Error("called outside the matrix")),
            { __matrix: def },
          );
        },
      };
      return builder;
    },
  };
});

vi.mock("@tanstack/react-start/server", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    getRequest: () =>
      new Request("https://gridlocked.example/_serverFn/matrix", {
        method: "POST",
        headers: { origin: "https://gridlocked.example" },
      }),
    setResponseHeader: () => {},
    getCookie: () => undefined,
    setCookie: () => {},
    deleteCookie: () => {},
  };
});

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    getViewer: async () => state.viewer,
    withRequestNow: (fn: (db: unknown, now: Date) => Promise<unknown>) =>
      fn(state.db, state.now),
    // An auth instance that refuses to be used: a function's guard has to
    // answer before it reaches Better Auth.
    withAuth: (
      fn: (auth: unknown, db: unknown, now: Date) => Promise<unknown>,
    ) =>
      fn(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("auth reached");
            },
          },
        ),
        state.db,
        state.now,
      ),
    requestSender: async () => null,
    siteBaseUrl: () => "https://gridlocked.example",
    requestCaptchaVerifier: () => ({ verify: async () => false }),
  };
});

const MODULES = {
  account: () => import("./account"),
  community: () => import("./community"),
  notifications: () => import("./notifications"),
  play: () => import("./play"),
  staff: () => import("./staff"),
} as const;

/** Every exported server function, as `module.name`. */
async function serverFunctions(): Promise<Map<string, Def>> {
  const all = new Map<string, Def>();
  for (const [module, load] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(await load())) {
      const def = (value as { __matrix?: Def } | null)?.__matrix;
      if (def) all.set(`${module}.${name}`, def);
    }
  }
  return all;
}

/** What a call comes back with: the refusal's code, or "answered". */
async function outcome(def: Def): Promise<string> {
  try {
    const result = await def.handler({ data: {} });
    if (
      result &&
      typeof result === "object" &&
      (result as { ok?: unknown }).ok === false
    ) {
      return String((result as { error: unknown }).error);
    }
    return "answered";
  } catch (error) {
    if (error instanceof IdentityError) return error.code;
    return `threw ${error instanceof Error ? error.name : typeof error}`;
  }
}

/**
 * The server functions that answer without a session, each for a reason.
 * Everything else must refuse a call with no session as `unauthenticated`.
 */
const PUBLIC: Record<string, string> = {
  "account.getAccount": "the header's account summary; null when signed out",
  "account.markPrivate": "marks a page's answer private; reads nothing",
  "account.getSignInOptions": "the sign-in page's buttons",
  "account.getConsentBoxes": "which documents the sign-up box names",
  "account.checkUsername": "sign-up's username check, rate-limited per address",
  "account.getEmailBusy": "sign-up's email check, rate-limited per address",
  "account.confirmMyDeletion":
    "the emailed deletion link; the link's token is the credential",
  "community.getForumFn": "the forum is public to read (decision 3)",
  "community.getCategoryFn": "the forum is public to read",
  "community.getThreadFn": "the forum is public to read",
  "community.chatGapFn": "a race thread's chat is public to read",
  "community.getComposerFn": "says a logged-out reader must sign in to post",
  "community.reportFn": "a logged-out report, behind Turnstile",
  "notifications.getPushKeyFn": "the public VAPID key",
  "play.getWeekend": "the hub is public (decision 3)",
  "play.getPrices": "the price board is public",
  "play.getHowPrices": "the price explainer is public",
  "staff.getStaffArea": "tells the route guard the area is closed",
};

/** Signed in, but not staff: refused as `forbidden`. */
const STAFF_ONLY = (name: string) =>
  (name.startsWith("staff.") && name !== "staff.getStaffArea") ||
  name === "account.unlockStaffTools";

describe("the access matrix (M9 Task 9)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let fns: Map<string, Def>;
  let player: Viewer;

  beforeAll(async () => {
    t = await createTestDb();
    state.db = t.db;
    player = await seedViewer(t.db as unknown as Db, { trustLevel: 1 });
    fns = await serverFunctions();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("finds every server function, and each public one is listed with a reason", () => {
    expect(fns.size).toBeGreaterThan(100);
    for (const name of Object.keys(PUBLIC)) {
      expect(fns.has(name), name).toBe(true);
    }
  });

  it("every server function not listed as public answers a call with no session with unauthenticated", async () => {
    state.viewer = null;
    const wrong: string[] = [];
    for (const [name, def] of fns) {
      if (name in PUBLIC) continue;
      const got = await outcome(def);
      if (got !== "unauthenticated") wrong.push(`${name}: ${got}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("every staff function answers a player with forbidden", async () => {
    state.viewer = player;
    const wrong: string[] = [];
    let checked = 0;
    for (const [name, def] of fns) {
      if (!STAFF_ONLY(name)) continue;
      checked++;
      const got = await outcome(def);
      if (got !== "forbidden") wrong.push(`${name}: ${got}`);
    }
    expect(checked).toBeGreaterThan(35);
    expect(wrong).toEqual([]);
  }, 120_000);

  it("the staff area says closed, with no queue counts, to no session and to a player", async () => {
    const def = fns.get("staff.getStaffArea")!;
    for (const viewer of [null, player]) {
      state.viewer = viewer;
      const area = (await def.handler({ data: {} })) as Record<string, unknown>;
      expect(area.state).not.toBe("open");
      expect(area).not.toHaveProperty("counts");
    }
  });

  it("the emailed deletion link refuses a call with no token", async () => {
    state.viewer = null;
    expect(await outcome(fns.get("account.confirmMyDeletion")!)).toBe(
      "invalid_link",
    );
  });
});
