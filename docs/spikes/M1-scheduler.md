# M1 spike: the scheduler tick on Neon's free plan

**Status:** complete (measured 2026-10-28 to 2026-10-29). The empty `m1-spike` branch awaits deletion (see Decision 5). **Verdict: fits as designed, with one change** (the safety tick runs every 6 hours, not hourly). Plan: [plans/M1-spike.md](../plans/M1-spike.md).

## The question
Can a once-a-minute scheduler tick run on Neon's free plan without keeping the database awake (HLD §4.5)? And where should the due-times file live?

## Setup
| What | Value |
|---|---|
| Project | `gridlocked-staging` (`ancient-fog-03461181`), Free plan, AWS US East 1, Postgres 17 |
| Compute | autoscaling capped at 0.25 CU (min and max), scale to zero after 5 minutes (fixed on Free) |
| Spike branch | `m1-spike` (`br-silent-queen-b80cfg04`), child of `main`, deleted at the end |
| Due-times file | bucket `scheduler` (private), key `due-times.json`, on `m1-spike` |
| Created | 2026-10-28 13:28 UTC |

**Noticed at setup:** the project reports a branch size limit of 512 MB (`branch_logical_size_limit`), not the 1 GB per project the plans page lists. Worth keeping in mind for DM size estimates; the M0 estimate (~70–120 MB) still fits.

## How usage is measured
Neon's usage APIs (`consumption_history`) are for paid plans only, so on Free:
- **Database:** the branch's `active_time_seconds`, `compute_time_seconds` and `cpu_used_sec` from the branch API, sampled every 10 minutes, plus `pg_endpoint` logs for when the compute starts and suspends.
- **Functions:** the function logs' invoke begin/end lines, which give each invocation's duration. Their sum is an upper bound on capacity-hours, because active and waiting time can't be split from logs.
- **Object Storage:** the storage logs, one line per request with its operation, size and duration.

First read at 13:29 UTC: both branches at 0 s active, 0 s CPU, 0 bytes. These counters lag, so this isn't a true baseline: `main` later showed 316 s from the project's creation.

## What the deployed tick does (Task 3, 2026-10-28)
The spike code is on branch [`spike/m1-scheduler`](https://github.com/psmak4/gridlocked/tree/spike/m1-scheduler/spikes/m1-scheduler), which is never merged. One function, `tick`, serves two triggers: `* * * * *` on `/` and `7 * * * *` on `/safety`.

**The bundle is 4.8 KB.** The deploy route available here takes the zip as text, so it uses no Hono, no `pg` and no AWS SDK. It talks to Postgres over Neon's HTTP SQL endpoint with `fetch`, and to Object Storage with a 60-line SigV4 signer that's tested against AWS's published example. Production code in M2 should use the real drivers; nothing here depends on avoiding them.

| Check | Result |
|---|---|
| A request without the trigger header, or with a forged one (Review Focus 5) | `403` both times. Neon strips client-set `X-Neon-*` headers. The logs show no storage or database activity for those requests |
| No due-times file yet (Review Focus 1) | Each tick read the file (`404`, 15 ms), logged `skip missing` and made no database call |
| The safety run | Published `next_due_at=null`. From the next minute, ticks logged `sleep` |
| A sleeping tick | **95–155 ms** end to end, almost all of it the Object Storage `GET` round trip |
| Two claims for the same job (Review Focus 3) | The first got the job and the second got 0 rows. One caveat: Neon's MCP can't prove the two calls overlapped in time, but Postgres re-checks `status = 'pending'` after waiting on the row lock, so overlap gives the same result |

**Measuring on Free.** The branch and project counters (`active_time_seconds` and the rest) lag behind activity; they read 0 for several minutes after the compute had clearly been woken. The `pg_endpoint` logs are empty on this branch, so compute starts and suspends can't be read from logs. The measurement therefore compares counter totals over a long window against the number of wakes the tick logged.

## Measurements
**Schedule seeded at 13:41 UTC on 28 Oct** (59 jobs):
- **Quiet period**, 13:41–02:00: jobs at 16:00, 20:00 and 00:00, plus the hourly safety runs.
- **Race-weekend window**, 02:00–08:00 on 29 Oct: a job every 10 minutes (36), plus a burst of 20 jobs all due at 05:03.

### What the logs show (13:41 on 28 Oct to 09:07 on 29 Oct)
- **Every minute without a due job slept.** The tick read the file (about 15–50 ms) and returned without touching Postgres.
- **The database woke only for due jobs and the safety runs:**
  - the 3 quiet jobs (16:00, 20:00, 00:00) and the hourly safety runs, 20 of them;
  - all 36 weekend jobs, one every 10 minutes from 02:00 to 07:50.
- **The burst worked.** All 20 jobs due at 05:03 were claimed and run in **one tick, in 246 ms**. Its compute cost wasn't isolated, because the database was already awake from the 05:00 job.
- **After the last job**, the file said `next_due_at=null`, and from 08:00 only the safety runs woke the database.
- **A woken tick** (claim, run, republish) takes 250–1,400 ms. The longer ones include the database waking from suspend.
- **Neon's cron skipped one minute.** There was no invocation at all at 04:50, and the 04:51 tick picked the job up (`run_at <= now`), one minute late. In about 1,170 scheduled minutes that's the only skip visible, but a skipped minute with nothing due leaves no trace in the logs. Nothing depends on a tick running on time (HLD §3.3 rule 3), so a skip costs a minute of latency.

### Usage
| Measure | Counters at 08:24 UTC (18.9 h after the branch was created) | Free allowance ([Neon plans](https://neon.com/docs/introduction/plans)) |
|---|---|---|
| Database awake time (`m1-spike`) | **5.22 h** (18,804 s), or **1.31 CU-hours** at 0.25 CU. Neon's own `compute_time_seconds` says 4,793 CU-seconds (1.33 CU-hours) | 100 CU-hours a month |
| …expected from wakes × ~5 min plus setup | ~4.9 h | |
| `main` branch (untouched by the spike) | 316 s, all at project creation | |
| Data transfer | 214 KB | 5 GB a month |
| Function invocations | ~1,180 (one a minute plus the safety runs) | 1M a month |
| Function time | sleeping ticks 80–155 ms, woken ticks ≤1.4 s: about 0.04 h in the window, about 1.5 h a month at this rate | 10 active and 400 waiting capacity-hours a month |
| Object Storage | one 96-byte file; a GET every minute and a PUT per wake | 5 GB; no per-request charge |

The measured awake time matches the design's prediction, about 5 minutes of compute per wake (Neon suspends after 5 idle minutes), to within 6.5% (5.22 h measured against ~4.9 h predicted). The 5 minutes per wake is inferred from total awake time, because Neon doesn't log compute starts on Free.

### Monthly extrapolation (0.25 CU, scheduler only)
| Source | Awake hours | CU-hours |
|---|---|---|
| Hourly safety runs (24 a day × 5 min) | ~60 | **15.0** |
| Everyday jobs (about 5 a day: syncs, reminders; assumed) | ~12.5 | 3.1 |
| Two race weekends (polls, roster and finalize checks; assumed ~10 h awake each, and a month can have three) | ~20 | 5.0 |
| **Total with hourly safety** | ~92 | **~23** of 100 |
| **Total with 6-hourly safety** | ~42 | **~11** of 100 |

Invocations come to about 43k a month (4% of the free 1M). Function time and transfer are negligible.

### Review Focus results
| Focus | Result |
|---|---|
| 1. A missing or malformed file | **Live, for the missing case:** ticks logged `skip missing` and made no database call, and the safety run republished the file. The malformed case is covered by unit tests only |
| 2. A past due time with no pending job | **Unit tests only.** The live tick always republished after waking, so a stale past due time never arose |
| 3. Two ticks for one minute | **Live, through Neon's MCP:** one claim got the job and the other got nothing. That the two calls overlapped in time can't be proven from there |
| 4. A due time exactly equal to `scheduled_at` | **Live:** every weekend job ran in the tick of its own minute, for example the 02:10 job in the 02:10 tick |
| 5. A request without the trigger header | **Live:** `403` with no header or a forged one, and no storage or database activity |

## Result
- **The tick fits the free tier.** The scheduler leaves the database asleep between due times. Its compute is about 5 minutes per wake, and a burst of due work costs one wake.
- **The biggest single cost is the safety run, not the minute tick.** At hourly it would use about 15 of the 100 CU-hours a month by itself.
- **The due-times file lives in Neon Object Storage.** Reading it never wakes Postgres, and Neon bills Object Storage by stored volume only, not per request ([Neon plans](https://neon.com/docs/introduction/plans)). It's on the same branch as the data, and Neon injects its credentials into the function, so the tick needs no secret. A writer outside Neon Functions, such as a future admin action on Vercel, would need its own bucket credential (decided with M8's admin tools).
- **Missed cron minutes happen and are harmless.** The `run_at <= now` check and the job table's dedupe keys cover them.

## Decision
1. **The due-times file lives in Neon Object Storage**, bucket `scheduler`, key `due-times.json` (HLD §4.5).
2. **The safety run moves from hourly to every 6 hours** (`7 */6 * * *`). That's about 2.5 CU-hours a month instead of 15. It's safe because the file is republished in the normal path:
   - the tick republishes after every wake, which covers every job a handler enqueues, including the calendar sync's plans;
   - code that enqueues outside a tick calls `republishIfEarlier`;
   - a missing or malformed file is republished by the next tick, at the cost of one wake (M2 ruling R24).

   The safety run is then only a backstop for an enqueue that skipped its republish. The worst case is that such a job runs up to 6 hours late.
3. **The tick keeps the M1 shape:**
   - it reads the file;
   - it sleeps when nothing is due;
   - it republishes a missing or malformed file once, with one wake (changed after M1's final review; the spike only skipped);
   - it skips without waking if the store itself can't be read;
   - when something is due, it claims jobs and always republishes the file;
   - it accepts only trigger calls (the `X-Neon-Trigger-Invocation-Id` header).
4. **Production code uses the real drivers**, `@neondatabase/serverless` and an S3 client. The spike's tiny fetch-based clients only existed because of the MCP deploy route. M2 Task 12 deploys through the `neon` CLI from CI.
5. **Cleanup (2026-10-29):** the spike's triggers, function and bucket are deleted, and staging's `main` branch has none. The empty `m1-spike` branch, holding only the spike's job table, is deleted once you confirm (Neon's tooling requires a confirmation for branch deletion). The code stays on branch `spike/m1-scheduler`, which is never merged.
