/**
 * Work that follows a Better Auth write and can't be lost (M9 Task 2, carried
 * from M5). Better Auth runs some of our work only after its transaction has
 * committed: its database after-hooks, `onPasswordReset`, the request
 * after-hook. A failure there used to lose the work, or fail a request whose
 * change had already happened.
 *
 * Now that work is a job (`identity_after_commit`), written first, inside
 * Better Auth's transaction where we can reach it (`auth/transactions.ts`),
 * and run straight away once it commits (`auth/after-commit.ts`). If that first try fails, the job is
 * still pending and the tick retries it a minute later, with the queue's
 * backoff. The payload holds ids, times and an already-redacted audit entry,
 * never an address, and is emptied when the work is done.
 *
 * Each run takes the job's row lock and empties the payload in the same
 * transaction as the work, so the work happens once: a second run, inline or
 * by the tick, finds nothing left to do.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AUDIT_ACTIONS, type AuditAction } from "@/audit/actions";
import { redactPersonal, writeAudit, type AuditEntry } from "@/audit/log";
import { authAccounts, jobs, profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import {
  auditUserChange,
  ensureProfile,
  resetHalfMadeSignUp,
  revokeUnprovenSignIns,
} from "./account-writes";
import { completeSignUp } from "./consent";

export const AFTER_COMMIT_KIND = "identity_after_commit";

/** How long the inline run has before the tick may take the job. */
const RETRY_AFTER_MS = 60_000;

const record = z.record(z.string(), z.unknown()).nullable();
const auditEntry = z.object({
  actorUserId: z.string().nullable().optional(),
  impersonatingUserId: z.string().nullable().optional(),
  actorKind: z.enum(["admin", "moderator", "user", "system", "job"]),
  actorLabel: z.string().nullable(),
  action: z.enum(Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]]),
  entityType: z.string(),
  entityId: z.string(),
  before: record,
  after: record,
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
});

/** When it happened, which the work is dated by, not by when it runs. */
const at = z.iso.datetime();

export const afterCommitWork = z.discriminatedUnion("event", [
  /** An audit row for a change Better Auth has made. */
  z.object({ event: z.literal("audit"), at, entry: auditEntry }),
  /** The age and terms boxes of the email sign-up form. */
  z.object({ event: z.literal("sign_up"), at, userId: z.string() }),
  /**
   * A reset of an unconfirmed account: the links it had go (the reset has
   * ended its sessions already), and the reset is audited.
   */
  z.object({
    event: z.literal("password_reset"),
    at,
    userId: z.string(),
    revokeAccountIds: z.array(z.string()),
  }),
  /** A magic link proved the address from another browser (Task 1). */
  z.object({ event: z.literal("sign_up_reset"), at, userId: z.string() }),
]);
export type AfterCommitWork = z.infer<typeof afterCommitWork>;

/** The work as it is stored: an audit entry already redacted. */
function stored(work: AfterCommitWork): AfterCommitWork {
  if (work.event !== "audit") return work;
  return {
    ...work,
    entry: {
      ...work.entry,
      before: redactPersonal(work.entry.before),
      after: redactPersonal(work.entry.after),
    },
  };
}

function subjectOf(work: AfterCommitWork): string {
  return work.event === "audit" ? work.entry.entityId : work.userId;
}

/**
 * Writes `work`'s job on `db`, which may be Better Auth's open transaction,
 * and gives back its id. `runAfterCommit` does the work.
 */
export async function keepAfterCommit(
  db: Db,
  now: Date,
  work: AfterCommitWork,
): Promise<string> {
  const { id } = await enqueue(db, {
    kind: AFTER_COMMIT_KIND,
    // Unique per occurrence: two resets are two jobs. The row lock, not the
    // key, is what keeps one occurrence from running twice.
    dedupeKey: `${work.event}:${subjectOf(work)}:${newId()}`,
    runAt: new Date(now.getTime() + RETRY_AFTER_MS),
    payload: stored(work),
  });
  return id;
}

/**
 * Runs one job's work under its row lock. `inline` is the first try, which
 * finishes the job itself; the tick's run leaves that to the runner.
 */
export async function runAfterCommit(
  db: Db,
  jobId: string,
  mode: "inline" | "tick",
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [job] = await t
      .select({ status: jobs.status, payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .for("update");
    if (!job) return;
    if (mode === "inline" && job.status !== "pending") return;
    // An empty payload is work already done.
    if (Object.keys(job.payload as object).length === 0) return;
    await perform(t, afterCommitWork.parse(job.payload));
    await t
      .update(jobs)
      .set(
        mode === "inline"
          ? { payload: {}, status: "succeeded", finishedAt: now }
          : { payload: {} },
      )
      .where(eq(jobs.id, jobId));
  });
}

async function perform(t: Db, work: AfterCommitWork): Promise<void> {
  const when = new Date(work.at);
  switch (work.event) {
    case "audit":
      await writeAudit(t, when, work.entry as AuditEntry);
      return;
    case "sign_up": {
      // A reset since (Task 1) took the sign-up password and the boxes with
      // it: what the first browser agreed to is no longer the account's.
      const [credential] = await t
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, work.userId),
            eq(authAccounts.providerId, "credential"),
          ),
        );
      if (!credential) return;
      await ensureProfile(t, when, work.userId);
      const [profile] = await t
        .select({ ageConfirmedAt: profiles.ageConfirmedAt })
        .from(profiles)
        .where(eq(profiles.userId, work.userId));
      if (profile?.ageConfirmedAt) return;
      await completeSignUp(t, when, {
        userId: work.userId,
        ageConfirmed: true,
        accepted: true,
      });
      return;
    }
    case "password_reset":
      await revokeUnprovenSignIns(t, when, work.userId, {
        accountIds: work.revokeAccountIds,
      });
      await auditUserChange(t, when, "user.password.update", work.userId);
      return;
    case "sign_up_reset":
      await resetHalfMadeSignUp(t, when, work.userId);
      return;
  }
}

/** The tick's handler for `identity_after_commit`. */
export function createIdentityAfterCommitHandler(): JobHandler {
  return async (job, { db, clock }) => {
    await runAfterCommit(db as unknown as Db, job.id, "tick", clock.now());
  };
}
