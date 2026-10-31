# Framework and Hosting Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** answer two questions, with evidence, before M3 adds server code and pages. First, can TanStack Start (1.x, stable since 13 Oct 2026) replace Next.js for everything the design needs? Second, which host serves the app best, free at launch, with a clear path to commercial use?

**Architecture:**
- On a throwaway branch, the repo itself is converted from Next.js to TanStack Start, so the spike shows the real migration cost and proves the existing checks still pass.
- The converted app then gets the five things most likely to go wrong:
  - a cacheable results page that reads real staging data;
  - Better Auth sign-in;
  - a protected page;
  - the chat-mode refresh endpoint (HLD decision 19);
  - a server-function mutation with an optimistic update.
- The same build is deployed to each shortlisted host, and one probe script measures all of them the same way.
- The result is a write-up with a recommendation. The decision stays yours.

**Tech Stack:**
- **Framework:** `@tanstack/react-start` and `@tanstack/react-router` 1.x, with Vite, `@vitejs/plugin-react`, `@tailwindcss/vite` and `vite-tsconfig-paths`.
- **Host adapters:** Nitro (Vercel and Neon Functions presets), `@netlify/vite-plugin-tanstack-start` and `@cloudflare/vite-plugin`.
- **App libraries:** Better Auth, using its TanStack Start integration and the `tanstackStartCookies` plugin; the existing Drizzle and `@neondatabase/serverless` code; and TanStack Query.

**Spec:**
- HLD §11.1–11.5: hosting, free tiers, caching and the stack.
- HLD decisions 3 (framework), 4–5 (Better Auth, sign-in methods) and 19 (chat refresh).
- [04-implementation-plan.md](../design/04-implementation-plan.md): M3 and M5 are the first milestones the result changes.

## Global Constraints
- **Throwaway code.** All spike code lives on the branch `spike/framework-start`, which is **never merged**. Only `docs/spikes/framework-hosting.md` (the result) and any design-doc changes reach `main`, through their own PR. If you choose to switch, the real migration is a separate, reviewed task, written from what the spike learned.
- **Staging's live weekend is off limits.** Nothing touches the `main` branch of `gridlocked-staging`, its `tick` function, its triggers or its `scheduler` bucket. Mexico City runs there until about 3 Nov, 22:00 UTC.
- **Neon:** a child branch `fw-spike` of `gridlocked-staging` main holds the spike's data. It inherits the imported 2026 season, so no import is needed. Spike-only tables (Better Auth's, and `spike_picks`) are created on that branch only. If the branch inherits any function or trigger, it's disabled before anything else runs there. The branch is deleted at the end, after you confirm.
- **New vendors need your approval first** (see Approvals). You create every account and log in to every CLI yourself. Each host's `DATABASE_URL` and `BETTER_AUTH_SECRET` are set by you, through the host's own prompt (`vercel env add`, `netlify env:set`, `wrangler secret put`). I never see or print them.
- **Pinned versions:** the newest `@tanstack/react-start` release that is at least 14 days old when Task 2 starts. Pin it exactly, along with each adapter.
- **Same app everywhere:** one commit of the spike app is deployed to every host. Only the adapter and its config differ, and each host's diff is recorded.
- **Free plans only.** No card goes on any account. Paid tiers are priced on paper (Task 1), never bought.
- **Cleanup:** every host project and the Neon branch is deleted at the end, after you confirm, and the write-up lists what was deleted.

## Approvals (needed before Task 3; Tasks 1–2 need none beyond this plan)
1. **The Neon child branch `fw-spike`** on `gridlocked-staging`, and on it one temporary Neon Function `web` for the Neon-hosted candidate. Staging's 100 CU-hours a month are shared by all its branches, so the spike's few hours come out of the same allowance as the live weekend. That allowance is about 11 CU-hours a month by the M1 measurement.
2. **Free accounts on Vercel (Hobby), Netlify (Free) and Cloudflare (Workers Free).** You create them and log in each CLI on this Mac: `vercel login`, `netlify login` and `wrangler login`. I deploy with those sessions.
3. **Which hosts get a real deploy.** My recommendation: Vercel, Netlify, Cloudflare and Neon Functions. Railway, Cloud Run and Oracle get a desk review only (Task 1), because none is a free, scale-to-zero host for this app.

## Review Focus
1. **A signed-in page served from the CDN to someone else.**
   - Any response that reads the session, or sets a cookie, must never be stored by a shared cache.
   - Expected: `/me` and every `Set-Cookie` response carry `private, no-store`.
   - Expected: a logged-out page fetched with a session cookie is not answered from cache.
   - *Pinned in Tasks 4 and 6.*
2. **The chat refresh URL not actually shared.** A query string, a `Vary` header, or the host's cache key can quietly give each person their own cache entry. That would turn about 2,400 database reads per race into about 1.2M (HLD §11.4). Expected: 30 requests inside one 3-second window reach the origin once. *Pinned in Tasks 3 and 6.*
3. **Password hashing on Cloudflare's free plan.** Better Auth's default scrypt hash can exceed Workers Free's 10 ms CPU limit, returning error 1102. Expected: the measured local CPU time and the real sign-up on Workers agree, and the write-up says whether Workers Free is viable for auth. *Pinned in Tasks 5 and 6.*
4. **The database connection from each host.** This covers the `@neondatabase/serverless` Pool on Workers, where one is created per request, versus Node hosts. It also covers round-trip time from each host's region to `aws-us-east-1`, and a cold start after idle. Expected: every host reads the results page with p50 under 300 ms when warm, and the cold first request is recorded. *Pinned in Task 6.*
5. **The scheduler breaking in the conversion.** The `tick` Function is bundled by `neon deploy` from `src/jobs/functions/tick.ts`, separately from the web app. Expected: the conversion leaves every `src/jobs`, `src/providers` and `src/db` test passing, and leaves `neon.ts` untouched. *Pinned in Task 2.*

---

### Task 1: Hosting desk review (controller, no cloud)

**Files:**
- Create: `docs/spikes/framework-hosting.md` (skeleton: questions, hosts, setup, measurements, result, decision), on branch `spike-result/framework-hosting`

**Interfaces:**
- Produces: the shortlist and, for each host, the numbers Task 6's probe is judged against.

- [ ] **Step 1:** Re-check from each host's own pricing, limits and terms pages, dated: Vercel Hobby, Netlify Free, Cloudflare Workers Free and Workers Paid ($5/month), Neon Functions, Railway, Cloud Run and Oracle Always Free. For each, record:
  - **Allowance:** requests or invocations, CPU, memory, transfer, CDN requests and deploys.
  - **Hard limits:** CPU per request and bundle size.
  - **Overage:** what happens when you go over: pause, fail or bill.
  - **Commercial use:** whether the free plan allows it (ads need it).
  - **Start support:** official partner, adapter or none.
  - **CDN caching:** whether the CDN honours `s-maxage` and `stale-while-revalidate`, and what goes into its cache key.
  - **Live chat:** whether it can hold WebSockets, such as Cloudflare Durable Objects. This is noted only; decision 19 stands unless you reopen it.
- [ ] **Step 2:** Work out HLD §11.4's race-weekend scenario on each host's numbers: 500 people refreshing a thread every 3 seconds for 2 hours, plus a normal week. Expected: a table of months-of-headroom per host.
- [ ] **Step 3:** Commit the skeleton with the desk table: `docs: start the framework and hosting spike write-up`.

### Task 2: Convert the repo to TanStack Start (local)

**Files (on `spike/framework-start`):**
- Create: `vite.config.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx`
- Modify: `package.json` (scripts `dev`/`build`/`start`, dependencies), `eslint.config.mjs`, `playwright.config.ts` (`webServer` command), `src/app/globals.css` → `src/styles/globals.css`, `tsconfig.json`
- Delete: `next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `next-env.d.ts`

**Interfaces:**
- Produces: `pnpm build` writes the server output; `pnpm start` serves it on `--port`. `@/` still resolves to `src/`.

- [ ] **Step 1:** Swap the toolchain and port the root layout (fonts, design tokens, `lang`, metadata through `head()`) and the home page. Add one shadcn/ui component (Button) with its CLI to check its Start support. Expected: `pnpm dev` shows the same "GRIDLOCKED" placeholder, and `e2e/smoke.spec.ts` passes unchanged.
- [ ] **Step 2:** Run the full CI sequence locally: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm db:drift`, `pnpm test --maxWorkers=3`, `pnpm build`, `pnpm e2e`. Expected: all pass, with the same test count as `main`.
- [ ] **Step 3:** Record in the write-up: files changed, packages added and removed, ESLint rules lost with `eslint-config-next`, and anything that took more than 15 minutes. Commit: `spike: convert the app to TanStack Start`.

### Task 3: The spike features (local, against `fw-spike`)

**Files:** `src/routes/results.$round.tsx`, `src/routes/api/threads.$id.latest.ts`, `src/routes/picks.tsx`, `src/spike/picks.ts`, `src/spike/cache.ts` (header helpers), `src/spike/*.test.ts`

**Interfaces:**
- Consumes: `createDb(url)` from `src/db/client.ts`, and the `results`, `sessions` and `events` schema.
- Produces: the routes Task 6 probes, with these headers:
  - `/results/$round`: `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`;
  - `/api/threads/$id/latest?w=<window>`: `public, s-maxage=3`, with `w = floor(epoch_seconds / 3)` computed by the client;
  - `/picks`: `private, no-store`.

- [ ] **Step 1:** After approval 1, create `fw-spike`, then check and disable any function or trigger it inherited. Then create `spike_picks(user_id text, round int, driver_id text, primary key (user_id, round))` and a `spike_hits(path text, at timestamptz)` origin-hit log.
- [ ] **Step 2:** `/results/$round`: the route loader reads round 18's race results from `fw-spike` through a server function, and the page renders the classification with `head()` title and description. Test: the header helper returns exactly the strings above for each route kind.
- [ ] **Step 3:** `/api/threads/$id/latest`: a server route that inserts one `spike_hits` row per origin hit and returns the window's latest rows. This stands in for `chat_messages` and reads results rows.
- [ ] **Step 4:** `/picks`: a `createServerFn` POST validated with Zod (`round`, `driverId`), and a TanStack Query mutation with an optimistic update and rollback on error. Test: the Zod schema rejects an unknown round.
- [ ] **Step 5:** Commit: `spike: results, chat refresh and picks routes`.

### Task 4: Better Auth (local, against `fw-spike`)

**Files:** `src/spike/auth.ts`, `src/spike/auth-client.ts`, `src/routes/api/auth.$.ts`, `src/routes/sign-in.tsx`, `src/routes/me.tsx`

- [ ] **Step 1:** Better Auth with the Drizzle adapter, email and password, the admin plugin, and `tanstackStartCookies()` last. Its tables are generated into the spike only and pushed to `fw-spike`. A local test secret is generated into a git-ignored `.env.spike`.
- [ ] **Step 2:**
  - `/me` is protected in `beforeLoad` by a server function calling `auth.api.getSession`; signed out, it redirects to `/sign-in`.
  - `/picks` requires a session.
  - The admin role is checked on one server function.
- [ ] **Step 3:** Playwright: sign up, sign out, sign in, open `/me`, make a pick, then sign out and `/me` redirects. Expected: it passes locally. Commit: `spike: Better Auth sign-in and protected routes`.
- [ ] **Step 4:** Note for the write-up, without building them, linking the docs for each and recording any Start-specific step:
  - magic link, which needs Resend;
  - Discord sign-in, which needs an OAuth app;
  - Turnstile, through the captcha plugin;
  - the Web Push service worker (HLD §15) under Vite.

### Task 5: Local measurements

- [ ] **Step 1:** CPU time per request for the server render of `/results/18`, warm, over 50 requests, and for one Better Auth sign-up and one sign-in (the scrypt hash), using `node --cpu-prof` or `process.cpuUsage()` around the handler. Expected: p50 and p95 in ms, judged against Workers Free's 10 ms.
- [ ] **Step 2:** The server bundle size, compressed, against each host's limit (Workers Free's is 3 MiB). Record both in the write-up.

### Task 6: Deploy to each host and probe (cloud, after approvals 1–3)

**Files:** `spikes/probe.sh` (curl only; reads the base URL from its argument). Per host: its adapter config, such as `wrangler.jsonc`, `netlify.toml` or the Nitro preset.

- [ ] **Step 1:** Deploy the same spike commit to each host. You set `DATABASE_URL` (the `fw-spike` pooled URL) and `BETTER_AUTH_SECRET` through each host's prompt.
  - On Neon Functions, deploy it as function `web` on `fw-spike` with the Neon MCP or CLI.
  - Put Cloudflare's free CDN in front only if Neon has no CDN of its own, and record it as a fifth vendor.
- [ ] **Step 2:** Run `probe.sh` against each host, which checks:
  - the first request after 15 minutes idle (cold);
  - 20 warm requests to `/results/18` (p50 and p95 TTFB);
  - a second request's cache headers (`age`, `cache-status`, `x-vercel-cache`, `cf-cache-status`);
  - 30 requests to `/api/threads/1/latest?w=<same>` within 3 s, then `select count(*) from spike_hits` for that window. Expected: 1.
  - `/results/18` with a session cookie, which must not come from cache;
  - sign-up, sign-in, `/me` and a pick, with the `Set-Cookie` attributes (`HttpOnly`, `Secure`, `SameSite`) and the cache headers on those responses.
- [ ] **Step 3:** Record per host: the deploy steps, from GitHub Actions or the CLI; how long a deploy takes; how logs are read; and where usage shows up against the free allowance.

### Task 7: Write-up, recommendation and cleanup

- [ ] **Step 1:** Finish `docs/spikes/framework-hosting.md`:
  - a framework verdict (switch or stay), with the migration cost from Task 2;
  - a host scorecard: free headroom, overage behaviour, commercial path and its price, Start support, CDN correctness, auth, latency, and the developer loop;
  - a recommendation, with what it costs if wrong.
- [ ] **Step 2:** List the design changes your decision would trigger, without making them:
  - HLD decision 3 and §11.5;
  - §11.2–11.4, if the host changes;
  - decision 19, only if a host makes live chat cheap;
  - the roadmap: a migration task before M3, and the deploy target in M5.
- [ ] **Step 3:** After you confirm, delete every host project and the `fw-spike` branch, and record what was deleted. Push `spike/framework-start` for the record, with no PR. Open the docs PR for the write-up.
