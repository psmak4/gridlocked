/**
 * Data export (DM 6.7, HLD §13.6): one JSON file of everything the registry
 * (`personal-data.ts`) exports, built by the `privacy_export` job, stored in
 * the `exports` bucket and downloaded through a link signed for 7 days. The
 * daily `expireExports` deletes the file after that, or at once for a
 * deleted account.
 *
 * The file holds no token, hash, secret or password: every reader picks its
 * columns by name. Logs carry counts and error names only.
 */
import { and, eq, gt, inArray, isNotNull, lte, ne, or } from "drizzle-orm";
import { privacyRequests, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { privacyExportKey, privacyExportPayload } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { queueEmail } from "./email/outbox";
import type { EmailSender } from "./email/sender";
import { PERSONAL_DATA } from "./personal-data";
import { IdentityError } from "./viewer";

/**
 * The port to the `exports` bucket. `src/providers/storage/export-store.ts`
 * has the S3 adapter and a memory one for tests.
 */
export interface ExportStore {
  put(key: string, body: string): Promise<void>;
  /** A GET link for `key` that works for `seconds`. */
  presign(key: string, seconds: number): Promise<string>;
  /** Deleting a key that isn't there is not an error. */
  delete(key: string): Promise<void>;
}

/** For wiring with no bucket: any use throws, so nothing is lost quietly. */
export const unconfiguredExportStore: ExportStore = {
  async put() {
    throw new Error("no export store is configured");
  },
  async presign() {
    throw new Error("no export store is configured");
  },
  async delete() {
    throw new Error("no export store is configured");
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** The download link, and so the file, lasts 7 days (SigV4's longest). */
export const EXPORT_LINK_SECONDS = 7 * 24 * 60 * 60;
/** Resend's idempotency window: an email row can't outlive it. */
const EMAIL_LIFETIME_MS = DAY_MS;

export const exportObjectKey = (requestId: string) =>
  `exports/${requestId}.json`;

const OPEN = ["pending", "processing"] as const;

/**
 * Asks for an export and queues `privacy_export`. One open request per user,
 * and one a day (`export_pending`, `export_too_soon`); a deleted account gets
 * `inactive`. A request still open after a day is taken to have failed (its
 * job ran out of attempts), so it doesn't block the next one for ever.
 */
export async function requestExport(
  db: Db,
  now: Date,
  { userId }: { userId: string },
): Promise<{ requestId: string }> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // The profile row serializes two requests from one user.
    const [profile] = await t
      .select({ status: profiles.status })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .for("update");
    if (!profile) throw new IdentityError("no_such_user");
    if (profile.status !== "active") throw new IdentityError("inactive");

    const dayAgo = new Date(now.getTime() - DAY_MS);
    const mine = and(
      eq(privacyRequests.userId, userId),
      eq(privacyRequests.kind, "export"),
    );
    await t
      .update(privacyRequests)
      .set({ status: "failed" })
      .where(
        and(
          mine,
          inArray(privacyRequests.status, OPEN),
          lte(privacyRequests.requestedAt, dayAgo),
        ),
      );
    const [open] = await t
      .select({ id: privacyRequests.id })
      .from(privacyRequests)
      .where(and(mine, inArray(privacyRequests.status, OPEN)))
      .limit(1);
    if (open) throw new IdentityError("export_pending");
    const [recent] = await t
      .select({ id: privacyRequests.id })
      .from(privacyRequests)
      .where(
        and(
          mine,
          ne(privacyRequests.status, "failed"),
          gt(privacyRequests.requestedAt, dayAgo),
        ),
      )
      .limit(1);
    if (recent) throw new IdentityError("export_too_soon");

    const requestId = newId();
    await t.insert(privacyRequests).values({
      id: requestId,
      userId,
      kind: "export",
      status: "pending",
      requestedAt: now,
    });
    await enqueue(t, {
      kind: "privacy_export",
      dedupeKey: privacyExportKey(requestId),
      runAt: now,
      payload: { requestId },
    });
    return { requestId };
  });
}

/**
 * The export: one section per registry entry with an `exportAs`, in registry
 * order. Posts, votes, chat and notification preferences join in M7 through
 * the same registry.
 */
export async function buildExport(
  db: Db,
  userId: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const entry of PERSONAL_DATA) {
    if (entry.exportAs === null || !entry.read) continue;
    out[entry.exportAs] = await entry.read(db, userId);
  }
  return out;
}

/**
 * The `privacy_export` handler: builds the file, stores it at
 * `exports/<requestId>.json`, signs a 7-day link, marks the request
 * `completed` with `export_expires_at`, and emails the link. For a deleted
 * account it stops quietly, writing nothing (and removes a file a crashed
 * earlier run may have left). A deletion that lands while the file is being
 * built is seen under the profile's lock, and the file is removed.
 */
export function createPrivacyExportHandler({
  store,
  sender,
  log = console.log,
}: {
  store: ExportStore;
  sender: EmailSender | null;
  log?: (line: string) => void;
}): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as unknown as Db;
    const now = ctx.clock.now();
    const { requestId } = privacyExportPayload.parse(job.payload);
    const key = exportObjectKey(requestId);

    const [row] = await db
      .select({
        userId: privacyRequests.userId,
        kind: privacyRequests.kind,
        status: privacyRequests.status,
        profileStatus: profiles.status,
      })
      .from(privacyRequests)
      .innerJoin(profiles, eq(profiles.userId, privacyRequests.userId))
      .where(eq(privacyRequests.id, requestId));
    if (!row || row.kind !== "export") return;
    if (row.profileStatus === "deleted") {
      await store.delete(key);
      log("privacy_export: account deleted, stopped");
      return;
    }
    if (row.status !== "pending" && row.status !== "processing") return;

    const data = {
      generatedAt: now.toISOString(),
      ...(await buildExport(db, row.userId)),
    };
    await store.put(key, JSON.stringify(data, null, 2));
    const url = await store.presign(key, EXPORT_LINK_SECONDS);

    const email = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [profile] = await t
        .select({ status: profiles.status, email: users.email })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(eq(profiles.userId, row.userId))
        .for("update", { of: profiles });
      if (!profile || profile.status === "deleted") return null;
      const done = await t
        .update(privacyRequests)
        .set({
          status: "completed",
          completedAt: now,
          exportObjectKey: key,
          exportExpiresAt: new Date(now.getTime() + EXPORT_LINK_SECONDS * 1000),
          exportUrl: url,
        })
        .where(
          and(
            eq(privacyRequests.id, requestId),
            inArray(privacyRequests.status, OPEN),
          ),
        )
        .returning({ id: privacyRequests.id });
      return done.length > 0 ? profile.email : null;
    });
    if (email === null) {
      await store.delete(key);
      log("privacy_export: account deleted or request closed, stopped");
      return;
    }

    try {
      await queueEmail(
        db,
        now,
        {
          to: email,
          template: "export_ready",
          payload: { url },
          expiresAt: new Date(now.getTime() + EMAIL_LIFETIME_MS),
        },
        sender,
      );
    } catch (error) {
      // The file and the link are there; the account page shows them.
      log(
        `privacy_export: email failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    log("privacy_export: completed");
  };
}

/**
 * Deletes export files past `export_expires_at`, and those of deleted
 * accounts at once, then clears the key and the link. Each file is deleted
 * before its row is cleared, so a failure leaves the row for the next run; a
 * failure doesn't stop the others, and the run throws at the end if any
 * failed. Returns how many it removed.
 */
export async function expireExports(
  db: Db,
  now: Date,
  store: ExportStore,
): Promise<number> {
  const due = await db
    .select({ id: privacyRequests.id, key: privacyRequests.exportObjectKey })
    .from(privacyRequests)
    .innerJoin(profiles, eq(profiles.userId, privacyRequests.userId))
    .where(
      and(
        isNotNull(privacyRequests.exportObjectKey),
        or(
          lte(privacyRequests.exportExpiresAt, now),
          eq(profiles.status, "deleted"),
        ),
      ),
    );
  let removed = 0;
  let failed = 0;
  for (const { id, key } of due) {
    try {
      await store.delete(key!);
      await db
        .update(privacyRequests)
        .set({ exportObjectKey: null, exportUrl: null })
        .where(
          and(
            eq(privacyRequests.id, id),
            eq(privacyRequests.exportObjectKey, key!),
          ),
        );
      removed++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    throw new Error(`expireExports: ${failed} of ${due.length} failed`);
  }
  return removed;
}
