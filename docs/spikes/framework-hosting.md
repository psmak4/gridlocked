# Spike: framework and hosting

**Plan:** [docs/plans/framework-hosting-spike.md](../plans/framework-hosting-spike.md). **Started:** 2026-10-30. **Status:** decided 2026-10-31: TanStack Start on Vercel Hobby, as recommended. The HLD and roadmap changes below are made.

## Questions

1. Can TanStack Start (1.x, stable since 13 Oct 2026) replace Next.js for everything the design needs?
2. Which host serves the app best, free at launch, with a clear path to commercial use (ads, HLD §16)?

## Hosts: desk review (Task 1, checked 2026-10-30)

Each row comes from the host's own pricing, limits or terms pages unless marked otherwise.

| Host | Free allowance (per month unless stated) | Over the limit | Commercial use on free | TanStack Start | CDN caching of SSR and API responses |
|---|---|---|---|---|---|
| **Vercel Hobby** | 1M function invocations; 4 Active CPU-hours; 360 GB-hours memory; **1M CDN requests**; 100 GB Fast Data Transfer; 10 GB Fast Origin Transfer; 100 deploys/day; functions up to 300 s; runtime logs kept 1 hour | the feature pauses for 30 days | **No**: "non-commercial, personal use only". Pro is $20 per developer seat per month | supported through the Nitro `vercel` preset (Vercel's own guide); not a TanStack hosting partner | honours `s-maxage` and `stale-while-revalidate` from function responses; never caches `Set-Cookie`, `private`, `no-store`, `Vary: Cookie` or requests with `Authorization`; cache is per region; `x-vercel-cache` shows the result |
| **Netlify Free** | 300 credits: a production deploy costs 15, 1 GB bandwidth 20, **10k web requests 2**, 1 GB-hour of functions 10; previews and branch deploys free | **every site on the account is paused** ("Site not available") until credits reset; no top-ups on Free | not restricted in the terms of use; plan terms sit in the Self-Serve Subscription Agreement (not checked). Personal is $9 for 1,000 credits | **official partner**, through `@netlify/vite-plugin-tanstack-start` | function responses are not cached by default. `Netlify-CDN-Cache-Control` / `CDN-Cache-Control` / `Cache-Control` honoured (`s-maxage`, `stale-while-revalidate`, `durable`); query strings are in the key, cookies are not; `Netlify-Vary` for finer keys; `Set-Cookie` responses were not cached in Task 6 (auth POSTs came back `no-cache`) |
| **Cloudflare Workers Free** | **100k requests per day**; **10 ms CPU per request** (Task 6: sign-in used 106–160 ms and still returned 200; not enforced strictly, but not to be relied on); 128 MB memory; 64 MiB uncompressed size; 50 subrequests per request; Durable Objects free (100k requests/day, 13,000 GB-s/day) | Error 1027 for the rest of the UTC day; no bill | yes | **official partner**, through `@cloudflare/vite-plugin` and Wrangler | the Cache API is explicit and per data center; **Workers Cache** returns cached Worker responses without running the Worker, honours `Cache-Control` (RFC 9111, including `stale-while-revalidate`), is tiered, and never caches `Set-Cookie`. **A cache hit is still billed as a Worker request**, so it likely counts toward the daily 100k (not tested: the spike used workers.dev with no cache in front) |
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

- Code: branch `spike/framework-start` (never merged). The conversion is commit a1b4edd; the spike routes, auth, probes and fixes follow it.
- Database: Neon `gridlocked-staging`, child branch `fw-spike` (`br-proud-cherry-b8417its`, 0.25 CU). Spike tables `spike_picks` and `spike_hits`, plus Better Auth's four tables. It inherited the `tick` function and both triggers, which came across disabled. Nothing touched staging `main`.
- Hosts (free plans, CLI deploys of the same commit): Vercel project `gridlocked-spike`, Netlify project `gridlocked-spike`, Cloudflare Worker `gridlocked-spike`, Neon Function `web` on `fw-spike`. No credentials are recorded here.

## Migration cost (Task 2)

- **Small.** The conversion itself is 16 files, +194/−113, without the lockfile (a1b4edd). The whole spike branch, with the spike routes, auth, probes and fixes, is 45 files, +1,629/−120. No step took more than 15 minutes.
- Removed: `next`, `eslint-config-next`, `@tailwindcss/turbopack`. Added: `@tanstack/react-start` 1.169.2, `@tanstack/react-router` 1.170.44, `vite` 8.3.4, `@vitejs/plugin-react`, `@tailwindcss/vite`, `nitro` 3.0.260903-beta, `typescript-eslint`, `eslint-plugin-react-hooks`, Fontsource for the three fonts.
- Mapping: `next/font` → self-hosted Fontsource (same families and CSS variables); `metadata` → root route `head()`; Next routes → file routes (`src/routeTree.gen.ts` is generated and committed); scripts → `vite dev` / `vite build` / `node .output/server/index.mjs`.
- Unchanged: Vitest (839 tests passed, the same as main), Drizzle, the providers, `src/jobs` and `neon.ts`. The scheduler's `tick` function is bundled separately and didn't notice.
- Lost: `eslint-config-next` brought eslint-plugin-react, a jsx-a11y subset and `@next/next` rules. A real migration should add eslint-plugin-react and eslint-plugin-jsx-a11y back.
- Risks:
  - **Nitro v3 is pre-release.** Start's Node, Vercel, Netlify-functions and Workers outputs here all went through it.
  - 20 harmless "use client" warnings from inside TanStack Router on every build.
- shadcn/ui: `shadcn init -t start` works. Its default primitives are now **Base UI, not Radix**, which is true for Next too.

## Measurements

### Local (Task 5)

Node 24 on this Mac, CPU per request (`process.cpuUsage`), with the local in-process PGlite counted in, so these are upper bounds for page renders:

| Request | p50 | p95 |
|---|---|---|
| `/` (no database) | 0.96 ms | 3.07 ms |
| `/results/18` (SSR + database) | 2.54 ms | 4.86 ms |
| chat endpoint (JSON + database) | 1.61 ms | 3.06 ms |
| sign-up / sign-in (scrypt) | 51 / 50 ms | 54 / 56 ms |

Server bundle (Node output, without PGlite): 3.4 MB raw, **0.78 MB gzip**. The Workers upload was 3.2 MiB / **727 KiB gzip**, under Workers Free's 3 MiB limit.

### Per host (Task 6)

From this Mac to the us-east hosts. Cold means the first request after 16 idle minutes, cache-busted, one sample each. The `fw-spike` database had also gone to sleep, so the first host probed (Vercel) probably paid for waking it.

| | Vercel Hobby | Netlify Free | Cloudflare Workers Free | Neon Functions |
|---|---|---|---|---|
| Deploy (prebuilt, CLI) | 6–9 s | 9–10 s | ~10 s | 5 s |
| `/results/18` warm TTFB p50 / p95 | **142–149 / 231–263 ms** | 186–228 / 275–298 ms | 361–399 / 681–834 ms | **136–138 / 219–229 ms** |
| `/results/18` cold | 2.08 s | 1.79 s | 0.65 s | 1.26 s |
| Chat: origin hits per 30 simultaneous requests | 29 | 20–24 | 30 | 30 |
| Chat: origin hits per 30 requests over 3 s | **3** | 20 | 30 | 30 |
| CPU for sign-up / sign-in | not metered (Node, ~50 ms locally) | same | **87–151 / 106–160 ms**, against 10 ms, but all 200 | not metered |
| Signed-in `/me` | `private, no-store`, never cached | same | same | same |
| Auth POSTs (`Set-Cookie`) | `public, max-age=0, must-revalidate`; MISS | `no-cache`; not cached | no `Cache-Control` | no `Cache-Control` |
| Logged-out page fetched with a session cookie | cache HIT (correct: same page for everyone, no `Set-Cookie`) | cache HIT | no cache in front | no CDN |
| Session cookie | `__Secure-…; HttpOnly; Secure; SameSite=Lax` on all four, after the fix below | | | |
| Sign up, sign in, pick, sign out (Playwright) | pass | pass | pass | pass |
| Logs | dashboard only: the CLI returned no records, the connector got a 403 | `netlify logs:function` | `wrangler tail` (gives CPU per request) | Neon console / MCP |

**Bugs the hosts found, fixed on the spike branch:**
- **The session cookie had no `Secure` flag on any host.** When the base URL is derived from the request, Better Auth decides `Secure` from `NODE_ENV`. The fix is `advanced: { useSecureCookies: true }`, with a test that failed first. The real app must keep it.
- **On slower hosts the first pick click did nothing.** It landed before hydration. The pick buttons now stay disabled until the user's picks have loaded. The real app needs the same rule for every server-rendered control.
- **Route `headers()` also apply to error responses** (from Task 3). A 500 went out marked `public, s-maxage=60, stale-while-revalidate=300`. Vercel doesn't cache a 5xx, but other CDNs do. The real app must send `no-store` on errors.
- **Not fixed: auth responses don't say `private, no-store`.** Better Auth's handler sets no `Cache-Control`. The hosts added `public, max-age=0, must-revalidate` (Vercel) or `no-cache` (Netlify). Nothing was cached (they were POSTs, and Vercel never caches `Set-Cookie`), but the plan expected `private, no-store` on every `Set-Cookie` response. The real `/api/auth/$` route should add it.
- One thing not explained: for about 2 minutes after a Vercel redeploy, the bare `/results/18` URL returned 500 straight from the function (`x-vercel-cache: MISS`) while a cache-busted URL returned 200. Then it cleared.

**Traps for the runbook:**
- Piping a secret from `pnpm dlx neon …` into `vercel env add` races the download and stores the wrong value. Fetch it into a variable first.
- Deleting `.netlify/` deletes the project link, and the next `netlify deploy` creates a new project on its own. Always pass `--site`.
- The first Workers deploy registers the account's workers.dev subdomain, and HTTPS fails for its first minutes.
- The Neon Function must bundle the client assets (`serveStatic: "inline"`), because Neon serves no static files.

## Result

**Framework: TanStack Start can replace Next.js.** Every feature the design needs ran on it:
- SSR with per-route title and description;
- server functions validated with Zod;
- API routes;
- per-route cache headers;
- TanStack Query with optimistic updates;
- Better Auth email and password, with the admin plugin and protected routes;
- shadcn/ui.

Magic link, Discord sign-in and Turnstile go through the same `/api/auth/$` handler, with no Start-specific step. Web Push needs a hand-written `public/sw.js` rather than vite-plugin-pwa, because Start renders on the server (Task 4 notes).

The same commit ran on four hosts with only a build-preset change. Next.js runs elsewhere through adapters, but Vercel is the host it is built and tested against.

**Host scorecard:**

| | Vercel Hobby | Netlify Free | Cloudflare Workers | Neon Functions |
|---|---|---|---|---|
| Free headroom | 1M CDN requests and 1M invocations a month | 300 credits, shared with **every site on the team** | 100k requests a day; 10 ms CPU | 1M invocations; 100 concurrent per account, shared with the scheduler |
| Over the limit | the feature pauses for 30 days | **every site on the team pauses**, including your existing live sites | error 1027 until the next UTC day | not stated |
| Commercial path | Pro, $20 per seat a month (needed before ads) | free allows it; Personal $9 | Paid, $5 a month (10M requests, 30 s CPU) | not stated |
| Start support | Nitro preset, beta | official partner | official partner | not documented; works through Nitro `standard` |
| CDN correctness | ✔ private pages never cached; absorbs steady chat (3/30) | ✔ private pages; chat leaks (20/30) | no cache in front on workers.dev (Workers Cache not tested) | no CDN |
| Auth | ✔ | ✔ | ✔ works, but sign-in is 9–16× over Free's CPU limit | ✔ |
| Warm latency (target p50 < 300 ms) | ✔ ~145 ms | ✔ ~200 ms | ✘ ~380 ms (a new database socket per request) | ✔ ~137 ms |
| Developer loop | 6–9 s deploys; logs dashboard-only | ~10 s; link trap | ~10 s; best live logs | 5 s; no static files |

## Decision

**Decision** (adopted 2026-10-31, as recommended):

1. **Switch the framework to TanStack Start, before M3.**
   - Why: the conversion is small now and grows with every screen; it removes the Next-on-Vercel coupling, and everything the design needs worked.
   - If wrong: Nitro v3 or Start trips us before M3, and we convert back. That is about the same 16 files, a day's work while the app is still a placeholder, and it gets more expensive after M3.
2. **Keep Vercel Hobby as the host** (HLD §11.2 is unchanged), moving to Pro before the first ad, as already planned.
   - Why: it was the only host that met every expectation measured, and the only one whose cache absorbed a steady stream of chat refreshes.
   - If wrong: Hobby's 1M CDN requests a month caps chat mode at about 50 people across a month of races (see the arithmetic above). Past that, the fix is Pro, or Cloudflare's free CDN in front with our own domain. Changing host is a preset and four env vars: about 10 seconds of deploy and a probe run.
3. **Not chosen:**
   - **Netlify:** its credit pause takes down every site on the team, and its cache let most chat refreshes through.
   - **Neon Functions as the web host:** no CDN, so every chat refresh is an invocation and a database read. It stays the scheduler's host.
   - **Cloudflare Workers:** Free can't take sign-in CPU. Paid ($5) is the cheapest commercial path, but it missed the latency target as configured. Worth one retest with Hyperdrive or Smart Placement only if the $15 a month difference from Vercel Pro matters once ads are near.

**Design changes (made 2026-10-31, with this write-up):**
- **HLD decision 3 and §11.5:**
  - Framework → TanStack Start (Vite, Nitro), pinned versions, with the Nitro pre-release noted as a risk.
  - UI → shadcn/ui on Base UI (its new default), not Radix.
  - ESLint → typescript-eslint, react-hooks, eslint-plugin-react and jsx-a11y.
- **HLD §11.2:** "hosts the Next.js app" → "hosts the TanStack Start app (Nitro `vercel` preset)". The host is unchanged.
- **HLD §11.4 correction:**
  - The chat refresh costs a Vercel **CDN request** every time, even when cached. 2,400 requests per person per race counts against Hobby's 1M CDN requests a month, so chat mode fits about 50 people, not 500.
  - The "about 2,400 invocations" figure holds only for refreshes spread across the window. Simultaneous requests are not collapsed (29 of 30 reached the app).
  - Add: error responses and every `/api/auth/*` response `private, no-store`; Better Auth `useSecureCookies: true`; server-rendered controls disabled until hydrated.
- **HLD §11.3:** add the measured rows, and Netlify's team-wide pause.
- **Decision 19:** unchanged. No host made live chat cheap at launch. Workers Paid with Durable Objects could, if Workers is ever chosen.
- **Roadmap:**
  - a migration task before M3 (convert, restore the lost lint rules, port the e2e);
  - M5's deploy target becomes the Nitro `vercel` preset, deployed prebuilt from CI;
  - M7's chat measurement keeps the staggered-load probe from this spike.

## Cleanup (2026-10-31)

Deleted after the measurements:
- Vercel project `gridlocked-spike` (`prj_FmkKFrulFxLRFR0yhizpFUJo4iGA`), with its deployments and env vars.
- Netlify project `gridlocked-spike` (`17f8de5e-a206-4bcd-90e2-0fdcb9323d65`). The stray `enchanting-naiad-1e2e94` was deleted earlier.
- Cloudflare Worker `gridlocked-spike`. The account's workers.dev subdomain `gridlocked` is an account setting and stays.
- Neon function `web` and branch `fw-spike` (`br-proud-cherry-b8417its`) in `gridlocked-staging`. Staging `main`, its `tick` function and both triggers were checked afterwards: unchanged and enabled.
- Local link and secret files (`.env.local`, `.env.spike`, `.vercel/`, `.netlify/`, `.wrangler/`).

The spike code stays on the unmerged branch `spike/framework-start` for reference.
