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
import { z } from "zod";
import { discordFrom } from "@/identity/env";
import { stopImpersonating } from "@/identity/impersonation";
import { verifyStaffSession } from "@/identity/staff-access";
import {
  consumeRateLimit,
  IdentityError,
  type Viewer,
} from "@/identity/viewer";
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
  usernameCheckKey,
} from "./account-actions";
import {
  changeUsernameAction,
  changeUsernameInput,
  confirmDeletionAction,
  confirmDeletionInput,
  deletePageState,
  exportState,
  favoritesState,
  profileState,
  removeSignInMethodAction,
  removeSignInMethodInput,
  requestDeletionAction,
  requestDeletionInput,
  requestExportAction,
  saveFavoriteSettingAction,
  saveFavoriteSettingInput,
  saveSpoilerSettingAction,
  saveSpoilerSettingInput,
  securityState,
  settingsOverview,
  signInMethodsState,
  usernameState,
} from "./settings-actions";
import {
  getViewer,
  requestSender,
  siteBaseUrl,
  withAuth,
  withRequestNow,
} from "./session";

/** What a page may know about the signed-in person. Nothing else leaves the server. */
export type AccountSummary = {
  complete: boolean;
  username: string | null;
  emailVerified: boolean;
  /** An admin is looking through this session (the banner, ruling 51a). */
  impersonated: boolean;
};

async function requestViewer(): Promise<Viewer | null> {
  return getViewer(getRequest());
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
      impersonated: viewer.impersonatedBy !== null,
    };
  },
);

/**
 * Marks the response in progress private. A redirect that depends on the
 * cookie (a logged-out visitor sent away from a signed-in step) calls this
 * before it throws, since route `headers()` don't run for a redirect.
 */
export const markPrivate = createServerFn({ method: "GET" }).handler(
  async (): Promise<null> => {
    setResponseHeader("Cache-Control", "private, no-store");
    return null;
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
    const headers = getRequest().headers;
    return withRequestNow(async (db, now) => {
      const viewer = await requestViewer();
      const within = await consumeRateLimit(
        db,
        now,
        usernameCheckKey(headers, viewer?.userId),
        { windowSeconds: 60, max: 60 },
      );
      if (!within) return { problem: null, limited: true };
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

// --- Profile and settings (M5 task 13) --------------------------------------
// Every one of these is about the signed-in person, so every answer is
// private (ruling 51e), whatever the route's own headers say.

function privately() {
  setResponseHeader("Cache-Control", "private, no-store");
}

export const getProfile = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db) => profileState(db, viewer));
  },
);

export const getSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) => settingsOverview(db, now, viewer));
  },
);

export const saveSpoilerSetting = createServerFn({ method: "POST" })
  .validator(saveSpoilerSettingInput)
  .handler(async ({ data }) => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      saveSpoilerSettingAction(db, now, viewer, data),
    );
  });

export const getFavoriteSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db) => favoritesState(db, viewer));
  },
);

export const saveFavoriteSettings = createServerFn({ method: "POST" })
  .validator(saveFavoriteSettingInput)
  .handler(async ({ data }) => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      saveFavoriteSettingAction(db, now, viewer, data),
    );
  });

export const getUsernameSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) => usernameState(db, now, viewer));
  },
);

export const changeMyUsername = createServerFn({ method: "POST" })
  .validator(changeUsernameInput)
  .handler(async ({ data }) => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      changeUsernameAction(db, now, viewer, data),
    );
  });

export const getSignInMethods = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    const state = await withRequestNow((db) => signInMethodsState(db, viewer));
    return { ...state, discordAvailable: discordFrom(process.env) !== null };
  },
);

export const removeSignInMethod = createServerFn({ method: "POST" })
  .validator(removeSignInMethodInput)
  .handler(async ({ data }) => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      removeSignInMethodAction(db, now, viewer, data),
    );
  });

export const getSecurity = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db) => securityState(db, viewer));
  },
);

const STAFF_REFUSALS = [
  "invalid_code",
  "rate_limited",
  "read_only",
  "forbidden",
  "staff_two_factor_required",
] as const;
export type UnlockResult =
  { ok: true } | { ok: false; error: (typeof STAFF_REFUSALS)[number] };

/** "Unlock staff tools": the staff two-step for this session (DM 6.4). */
export const unlockStaffTools = createServerFn({ method: "POST" })
  .validator(z.object({ code: z.string().trim().min(1).max(64) }))
  .handler(async ({ data }): Promise<UnlockResult> => {
    privately();
    const viewer = await requestViewer();
    if (!viewer) throw new IdentityError("unauthenticated");
    try {
      await withAuth((auth, db, now) =>
        verifyStaffSession(auth, db, now, { viewer, code: data.code }),
      );
      return { ok: true };
    } catch (error) {
      if (
        error instanceof IdentityError &&
        (STAFF_REFUSALS as readonly string[]).includes(error.code)
      ) {
        return {
          ok: false,
          error: error.code as (typeof STAFF_REFUSALS)[number],
        };
      }
      throw error;
    }
  });

export const getDataExport = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) => exportState(db, now, viewer));
  },
);

export const requestMyExport = createServerFn({ method: "POST" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) => requestExportAction(db, now, viewer));
  },
);

export const getDeleteAccount = createServerFn({ method: "GET" }).handler(
  async () => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db) => deletePageState(db, viewer));
  },
);

export const requestMyDeletion = createServerFn({ method: "POST" })
  .validator(requestDeletionInput)
  .handler(async ({ data }) => {
    privately();
    const request = getRequest();
    const viewer = await requestViewer();
    const deps = {
      sender: await requestSender(),
      baseUrl: siteBaseUrl(request),
    };
    return withRequestNow((db, now) =>
      requestDeletionAction(db, now, viewer, data, deps),
    );
  });

/** The emailed link's button; works signed out, since the token is the proof. */
export const confirmMyDeletion = createServerFn({ method: "POST" })
  .validator(confirmDeletionInput)
  .handler(async ({ data }) => {
    privately();
    const viewer = await requestViewer();
    return withRequestNow((db, now) =>
      confirmDeletionAction(db, now, viewer, data),
    );
  });

/**
 * The banner's Stop (ruling 51a): ends the impersonation and sets the
 * admin's own session cookie back. `/admin/stop-impersonating` is closed
 * over HTTP, so this is the way out besides signing out.
 */
export const stopImpersonation = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    privately();
    const request = getRequest();
    const viewer = await requestViewer();
    // `tanstackStartCookies` puts Better Auth's Set-Cookie on this response,
    // the admin's session among them: the only cookie path, so it's sent once.
    await withAuth((auth, db, now) =>
      stopImpersonating(auth, db, now, { viewer, headers: request.headers }),
    );
    return { ok: true };
  },
);
