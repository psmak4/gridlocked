# M1 spike: the scheduler tick on Neon's free plan

**Status:** in progress (started 2026-10-28). Plan: [plans/M1-spike.md](../plans/M1-spike.md).

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

Baseline at 13:29 UTC: both branches at 0 s active, 0 s CPU, 0 bytes transferred.

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

_Results to fill in (Task 4)._

## Result
_To fill in (Task 5)._

## Decision
_To fill in (Task 5)._
