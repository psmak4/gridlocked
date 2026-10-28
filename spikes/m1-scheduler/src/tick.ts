// The scheduler tick (HLD §4.5), deployed as the Neon Function `tick`.
//   POST /        every minute: wake Postgres only if something is due
//   POST /safety  hourly: check the job table and republish the file
import { decideTick } from "./decide";
import { parseDueFile } from "./due-file";
import { claimDueJobs, DUE_KEY, finishJobs, publishDueFile } from "./jobs";
import { makeSql } from "./neon-sql";
import { makeBucket } from "./s3";

const env = process.env;

async function scheduledAt(request: Request): Promise<Date | null> {
  try {
    const body = (await request.json()) as { data?: { scheduled_at?: string } };
    const at = body.data?.scheduled_at;
    return at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)}ms`;
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/" && path !== "/safety")) return new Response("not found", { status: 404 });
    // Neon strips client-set X-Neon-* headers, so this proves a trigger sent it.
    if (!request.headers.get("x-neon-trigger-invocation-id")) return new Response("forbidden", { status: 403 });
    const now = await scheduledAt(request);
    if (!now) return new Response("missing data.scheduled_at", { status: 400 });

    const bucket = makeBucket({
      endpoint: env.AWS_ENDPOINT_URL_S3!,
      region: env.AWS_REGION!,
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      bucket: "scheduler",
      now: () => now,
    });
    const sql = () => makeSql(env.DATABASE_URL!);
    const at = now.toISOString();

    if (path === "/safety") {
      const file = await publishDueFile(bucket, sql(), now);
      console.log(`safety ${at} published next_due_at=${file.next_due_at} ${ms()}`);
      return Response.json({ ok: true, file });
    }

    const decision = decideTick(parseDueFile(await bucket.get(DUE_KEY)), now);
    if (decision.action !== "wake") {
      console.log(`tick ${at} ${decision.action}${decision.action === "skip" ? ` ${decision.reason}` : ""} ${ms()}`);
      return Response.json({ ok: true, decision });
    }
    const db = sql();
    const jobs = await claimDueJobs(db, now);
    await finishJobs(db, jobs.map((j) => j.id), now);
    const file = await publishDueFile(bucket, db, now);
    console.log(`tick ${at} wake ran=${jobs.length} kinds=${jobs.map((j) => j.kind).join(",")} next_due_at=${file.next_due_at} ${ms()}`);
    return Response.json({ ok: true, decision, ran: jobs.length, file });
  },
};
