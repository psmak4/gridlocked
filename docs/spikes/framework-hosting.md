# Spike: framework and hosting

**Plan:** [docs/plans/framework-hosting-spike.md](../plans/framework-hosting-spike.md). **Started:** 2026-10-30. **Status:** in progress (Task 1 done).

## Questions

1. Can TanStack Start (1.x, stable since 13 Oct 2026) replace Next.js for everything the design needs?
2. Which host serves the app best, free at launch, with a clear path to commercial use (ads, HLD §16)?

## Hosts: desk review (Task 1, checked 2026-10-30)

Each row comes from the host's own pricing, limits or terms pages unless marked otherwise.

| Host | Free allowance (per month unless stated) | Over the limit | Commercial use on free | TanStack Start | CDN caching of SSR and API responses |
|---|---|---|---|---|---|
| **Vercel Hobby** | 1M function invocations; 4 Active CPU-hours; 360 GB-hours memory; **1M CDN requests**; 100 GB Fast Data Transfer; 10 GB Fast Origin Transfer; 100 deploys/day; functions up to 300 s; runtime logs kept 1 hour | the feature pauses for 30 days | **No**: "non-commercial, personal use only". Pro is $20 per developer seat per month | supported through the Nitro `vercel` preset (Vercel's own guide); not a TanStack hosting partner | honours `s-maxage` and `stale-while-revalidate` from function responses; never caches `Set-Cookie`, `private`, `no-store`, `Vary: Cookie` or requests with `Authorization`; cache is per region; `x-vercel-cache` shows the result |
| **Netlify Free** | 300 credits: a production deploy costs 15, 1 GB bandwidth 20, **10k web requests 2**, 1 GB-hour of functions 10; previews and branch deploys free | **every site on the account is paused** ("Site not available") until credits reset; no top-ups on Free | not restricted in the terms of use; plan terms sit in the Self-Serve Subscription Agreement (not checked). Personal is $9 for 1,000 credits | **official partner**, through `@netlify/vite-plugin-tanstack-start` | function responses are not cached by default. `Netlify-CDN-Cache-Control` / `CDN-Cache-Control` / `Cache-Control` honoured (`s-maxage`, `stale-while-revalidate`, `durable`); query strings are in the key, cookies are not; `Netlify-Vary` for finer keys; `Set-Cookie` handling not documented (Task 6 checks) |
| **Cloudflare Workers Free** | **100k requests per day**; **10 ms CPU per request**; 128 MB memory; 64 MiB uncompressed size; 50 subrequests per request; Durable Objects free (100k requests/day, 13,000 GB-s/day) | Error 1027 for the rest of the UTC day; no bill | yes | **official partner**, through `@cloudflare/vite-plugin` and Wrangler | the Cache API is explicit and per data center; **Workers Cache** returns cached Worker responses without running the Worker, honours `Cache-Control` (RFC 9111, including `stale-while-revalidate`), is tiered, and never caches `Set-Cookie`. **A cache hit is still billed as a Worker request**, so it likely counts toward the daily 100k (Task 6 checks) |
| **Cloudflare Workers Paid** | $5/month: 10M requests and 30M CPU-ms included, then $0.30 per M requests and $0.02 per M CPU-ms; CPU per request up to 5 min (default 30 s); no egress charges | bills the overage | yes | as above | as above |
| **Neon Functions** | per project: 1M invocations, 10 active and 400 waiting capacity-hours; 100 concurrent invocations **per account** (shared with the scheduler tick); 2 GiB memory; Node 24 | not stated on the plans page (the database stops at its own limits) | not stated on the plans page | not documented by Neon; a third-party tool (Alchemy) documents TanStack Start on Neon Functions through Nitro's Node target | **no CDN in front**; every request is an invocation unless a CDN is put in front |
| **Railway** | Free: $1 of usage per month (0.5 GB RAM, 1 vCPU per service); Hobby $5/month including $5 of usage; vCPU $20/month, RAM $10/GB/month, egress $0.05/GB | bills (Hobby and Pro) | yes (paid plans) | **official partner** | none built in; an always-on container, no scale to zero documented |
| **Cloud Run** | not rechecked (the pricing page didn't load); the HLD's 2026-10-27 figures were 2M requests, 180k vCPU-s, 360k GiB-s | **bills**; needs a billing account and card; budgets alert but don't cap | yes | ordinary Node container | none built in |
| **Oracle Always Free** | 2 Arm OCPUs and 12 GB RAM always on; 10 TB/month outbound | no metering | yes | ordinary Node server | none built in; we'd run and patch the server, and idle VMs (p95 CPU, network and memory all under 20% for 7 days) may be reclaimed |

## Race-weekend arithmetic (Task 1 Step 2)

**The chat refresh breaks free plans through their request meters, even when cached.** HLD §11.4 counted only function invocations: about 2,400 per race if every refresh in a 3-second window shares one cached response. That part holds. But every refresh is still a request to the CDN, and the free plans meter those requests too:

- One person watching a 2-hour race in chat mode makes 7,200 s ÷ 3 s = **2,400 requests**.
- So a race costs **2,400 × N requests**, where N is the number of people in chat: 120k at N = 50, 240k at 100, 1.2M at 500.
- A month with chat on 5 sessions (qualifying and race on two weekends, plus a sprint) costs 12,000 × N.

| Host | Meter the refresh hits | N = 50 | N = 100 | N = 500 |
|---|---|---|---|---|
| Vercel Hobby | 1M CDN requests/month | 600k/month: fits, with ~400k left for pages | 1.2M/month: **over**, the feature pauses for 30 days | one race (1.2M) is **over** |
| Netlify Free | 2 credits per 10k web requests, of 300 credits | 120 credits/month, plus deploys: fits, tight | 240 credits plus deploys: **at the limit**, and the whole site pauses | one race is 240 credits |
| Cloudflare Workers Free | 100k requests/day | one race (120k) is **over**: error 1027 about 100 minutes into the race | **over** in about 50 minutes | **over** in about 10 minutes |
| Cloudflare Workers Paid ($5) | 10M requests/month included | fits | fits | 6M/month: fits |
| Neon Functions alone | 1M invocations/month, 100 concurrent | 600k invocations plus every page view: fits, tight, and every refresh reads the database | 1.2M: **over** | **over** |
| Any origin behind Cloudflare's CDN (proxied DNS) | none: Cloudflare's free CDN doesn't meter requests; the origin sees about one request per window per data center | fits | fits | fits |

**What this means:**
- On any free plan, chat mode only fits a small community: about 50 people in a thread on Vercel or Netlify, and fewer on Workers Free.
- Two ways past that:
  - **Workers Paid at $5/month:** the cheapest commercial path. It also lifts the 10 ms CPU limit and offers Durable Objects, which would make real live chat affordable. That would let decision 19 be reopened if you choose to.
  - **Cloudflare's free CDN in front of whichever host serves the app:** it needs a domain we own, and a cache rule that makes the chat URL and logged-out pages cacheable. It can't be tested on the spike's default `*.vercel.app`, `*.netlify.app` or `*.workers.dev` URLs, so Task 6 can only check it if a domain exists.
- A normal week is small next to that. For example, 300 people making 20 page views a week is about 26k requests a month, which every candidate absorbs.

## Setup

_(Task 3 onwards: the `fw-spike` branch id, host project names. No credentials are recorded.)_

## Migration cost (Task 2)

## Measurements

### Local (Task 5)

### Per host (Task 6)

## Result

## Decision
