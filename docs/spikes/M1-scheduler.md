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

## Measurements
_To fill in (Task 4)._

## Result
_To fill in (Task 5)._

## Decision
_To fill in (Task 5)._
