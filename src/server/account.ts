/**
 * The server functions behind sign-up and onboarding (M5 task 12). Each one
 * reads the viewer from the request cookie (no cookie, no database), checks
 * its input with Zod, and checks the viewer with `requireViewer` or
 * `requireWritable`. The work is in `account-actions.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  getCookie,
  getRequest,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { discordFrom } from "@/identity/env";
import { consumeRateLimit, type Viewer } from "@/identity/viewer";
import {
  checkUsernameAction,
  checkUsernameInput,
  emailBusyAction,
  finishSignUpAction,
  finishSignUpInput,
  onboardingState,
  saveFavoritesAction,
  saveFavoritesInput,
  saveSpoilersAction,
  saveSpoilersInput,
} from "./account-actions";
import { getViewer, withRequestNow } from "./session";

/** What a page may know about the signed-in person. Nothing else leaves the server. */
export type AccountSummary = {
  complete: boolean;
  username: string | null;
  emailVerified: boolean;
};

async function requestViewer(): Promise<Viewer | null> {
  return getViewer(getRequest());
}

/** The browser's address as the platform reports it, for rate limits. */
function clientAddress(): string {
  const headers = getRequest().headers;
  const forwarded =
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/** Who is signed in, or null. Read by the gate on every page. */
export const getAccount = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountSummary | null> => {
    const viewer = await requestViewer();
    if (!viewer) return null;
    // A signed-in answer is private, whoever asked and however.
    setResponseHeader("Cache-Control", "private, no-store");
    return {
      complete: viewer.complete,
      username: viewer.displayUsername ?? viewer.username,
      emailVerified: viewer.emailVerified,
    };
  },
);

/** Which ways in this site offers. Only a yes or no: never the client id. */
export const getSignInOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ discord: boolean }> => ({
    discord: discordFrom(process.env) !== null,
  }),
);

export type UsernameCheck = {
  problem: "format" | "reserved" | "held" | "taken" | null;
  limited: boolean;
};

/** Why a username can't be used, without a reload. Open to the logged out, so limited. */
export const checkUsername = createServerFn({ method: "POST" })
  .validator(checkUsernameInput)
  .handler(({ data }): Promise<UsernameCheck> => {
    const address = clientAddress();
    return withRequestNow(async (db, now) => {
      const within = await consumeRateLimit(
        db,
        now,
        `username-check:${address}`,
        { windowSeconds: 60, max: 60 },
      );
      if (!within) return { problem: null, limited: true };
      const viewer = await requestViewer();
      return {
        problem: await checkUsernameAction(
          db,
          now,
          data.username,
          viewer?.userId,
        ),
        limited: false,
      };
    });
  });

/**
 * Whether emails are queued today ("It might take a while today"). A local
 * build (the flag is replaced at build time, so a deployed one drops this)
 * can force it with a cookie, so a test can see the notice without using up
 * the real allowance.
 */
export const getEmailBusy = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ busy: boolean }> => {
    if (
      import.meta.env.VITE_LOCAL_DB === "1" &&
      getCookie("gl-test-busy") === "1"
    ) {
      return { busy: true };
    }
    return withRequestNow(async (db, now) => ({
      busy: await emailBusyAction(db, now),
    }));
  },
);

export const finishSignUp = createServerFn({ method: "POST" })
  .validator(finishSignUpInput)
  .handler(async ({ data }) => {
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      finishSignUpAction(db, now, viewer, data),
    );
  });

/** Step 1 and 2 start from this: the saved choices, and the lists to pick from. */
export const getOnboarding = createServerFn({ method: "GET" }).handler(
  async () => {
    const viewer = await requestViewer();
    return withRequestNow((db) => onboardingState(db, viewer));
  },
);

export const saveFavorites = createServerFn({ method: "POST" })
  .validator(saveFavoritesInput)
  .handler(async ({ data }) => {
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      saveFavoritesAction(db, now, viewer, data),
    );
  });

export const saveSpoilers = createServerFn({ method: "POST" })
  .validator(saveSpoilersInput)
  .handler(async ({ data }) => {
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      saveSpoilersAction(db, now, viewer, data),
    );
  });
