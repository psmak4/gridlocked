# M9 load tests on staging (Task 12)

Three runs against staging, read-only, with no cookies, from one machine. Each records:

- requests;
- status and `x-vercel-cache` counts;
- non-HIT answers, which are at most that many function invocations;
- latency percentiles.

The runs are measured against Vercel Hobby's limits (HLD §11.3, §11.4).

**Status: not run yet.** The runs need a staging deploy with your OK. The scripts are ready, with their unit tests on a fake clock and fetch.

## The runs

| Run | Command | What passing looks like |
| - | - | - |
| Race end, 500 readers | `RACE_LOAD_URL=https://<staging> pnpm race-end-load --readers=500 --ramp=60 --interval=30 --seconds=600` | Nearly every answer a `HIT`: about one non-HIT per page per stale window (30 s, or 10 s near a lock, from Task 6); 200s throughout; p95 under a second |
| Chat, 50 readers | `CHAT_LOAD_URL=https://<staging> CHAT_LOAD_THREAD=<thread id> CHAT_LOAD_SECONDS=600 pnpm chat-load --readers=50` | At most 2 non-HITs a 3-second window. M7 measured 2.7 |
| Chat, 150 readers | the same with `--readers=150` | The same per window: invocations should grow with windows, not with readers |

If chat still misses more than twice a window, Task 12 collapses the first requests of a window: the client asks for the next window's address a moment before the window starts. Then it tests that, deploys, and runs chat again.

## Results

| Run | Requests | Status | Cache | Non-HIT | p50 / p95 / max (ms) |
| - | - | - | - | - | - |
| Race end, 500 | | | | | |
| Chat, 50 | | | | | |
| Chat, 150 | | | | | |

## Against Hobby

To fill in from the runs: function invocations a race weekend, extrapolated from the non-HIT rates, against Hobby's 1M a month. Also CDN requests against the 1M a month (HLD §11.4: one person in chat for a 2-hour race makes 2,400).
