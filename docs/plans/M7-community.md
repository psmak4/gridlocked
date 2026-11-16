# M7 Community Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** race weekends feel alive (roadmap M7, epic psmak4/gridlocked#8).

**Exit:**
- the roadmap's key tests pass at phone size on the replay-mode build:
  - every Part 5 scenario row;
  - spoiler protection across titles, chat, scores and notifications;
  - logged-out visitors being spoiler-safe;
  - slow mode;
  - the spoiler title check;
  - a report flow and auto-hide;
  - a data export that includes archived chat;
- every wave 4 forum and notifications board, and wave 2's live-thread boards, has a test or a named later milestone;
- the M5 carry-overs are done or ruled on;
- staging runs the forum, and the chat load test has a measured answer (decision 6).

**Architecture:**
- **Two new modules.** `src/community/` holds the forum, chat and moderation, and `src/notifications/` holds notifications, broadcasts and push. Each function is `(db, now, input) → plain object`, tested on PGlite without the Start runtime, like `src/play/`. `src/server/community.ts` and `src/server/notifications.ts` wrap them in Zod-checked `createServerFn`s with `withRequestNow`.
- **One posting gate.** Every write of a thread, post or chat message goes through `checkPost` (Task 4). It covers trust level, restrictions, rate limits, filters, link and mention limits, duplicates and the spoiler title check, in one place, before the insert. The insert re-checks what the database can (DM 5.5: "checked again on insert").
- **Spoilers use M6's check.** `revealedSessions` decides, per viewer, which sessions' threads, chat, notifications and results posts may be sent. **Hidden content is never in the response.** A hidden thread sends its spoiler-safe title and no posts; hidden chat isn't fetched.
- **Chat refreshes through `RealtimeChannel`** (HLD §11.2), with "refresh" as its only implementation. The refresh URL is **the same for every viewer** (`/api/chat/$threadId?after=<window>`), carries no cookie and no `Vary: Cookie`, and is `public, s-maxage=3`. That's what lets Vercel's CDN share one read across a crowd. M6 found that a `Vary: Cookie` response is never cached. A viewer who hasn't revealed the session never asks for it.
- **Jobs use the existing queue.** New kinds: `open_threads` (an event's session threads), `results_post`, `chat_archive`, `lock_reminder`, `hot_rank`, `community_daily` (reputation and retention) and `push_fanout`. Each has a dedupe key, as DM 2.10 requires.

**Tech Stack:** TanStack Start, React 19, Drizzle, Postgres with `ltree` (PGlite's `contrib/ltree` in tests, Neon in staging), Zod, the M6 design-system components on Base UI, Tailwind 4, Vitest, Playwright with axe-core. **New dependencies only as decisions 3 and 4 allow.**

**Spec:**
- [02-data-model.md](../design/02-data-model.md) Part 5 (5.1–5.16), still marked "proposed" (decision 1);
- [01-high-level-design.md](../design/01-high-level-design.md) §7, §10, §11.2 and §11.4;
- [03-ui-brief.md](../design/03-ui-brief.md):
  - wave 2's live session thread and spoiler states ([canvas](https://claude.ai/artifact/6ffGHC4QcgEgRZv6pGgwfU));
  - wave 4's forum and notifications rows ([canvas](https://claude.ai/artifact/V1zQ2UffcabkH67GNgJiSS)), for the exact copy;
- the design system [Gridlocked](https://claude.ai/artifact/PUXqoEEV5XrSJtsfELx7b9): component names and props;
- [04-implementation-plan.md](../design/04-implementation-plan.md) M7, including "Carried from M5".

## What checking the spec turned up
I read Part 5, HLD §7, §10 and §11, wave 4, and the M5 and M6 code M7 sits on. These change what the roadmap says, and the tasks below follow them.

1. **DM Part 5 was never approved.** Parts 1–4 and 6 were reviewed part by part. Part 5 still says "(proposed)", and so do its retention (5.10), search (5.12) and HLD §7.4's trust table. M7 builds Part 5, so it needs your approval first (decision 1).
2. **The CDN problem M6 found shapes chat.** Vercel never caches a response with `Vary: Cookie`. HLD §11.4's budget for chat (about 50 people a month on Hobby) assumes every refresh in a 3-second window shares one cached answer. So the refresh endpoint must not depend on who's asking: no cookie read, no `Vary`, the same bytes for everyone. Spoiler gating moves to the client's decision whether to ask (architecture above). Logged-out **thread pages** have M6's problem too. They follow M6's rule (correct, uncached) until M9 fixes caching for all public pages.
3. **The email outbox is done.** M5 built `email_outbox`, the caps, the flush job and the 80% alert (DM 5.11). Email stays for account messages only (HLD §10), so M7 adds no email.
4. **There's no PWA yet.** The app has no web manifest and no service worker, and Web Push needs both. On iOS it also needs the app added to the home screen. Task 14 adds both, with the push opt-in sheet saying so.
5. **`ltree` works on both databases.** Neon supports it, and PGlite ships `@electric-sql/pglite/contrib/ltree`. The test database loads the extension and the migration creates it.
6. **Chat archives need storage.** M5's exports use an `exports` bucket in Neon Object Storage (`src/providers/storage/export-store.ts`). Archives keep for good, exports for 7 days, so they want separate buckets (decision 5).
7. **Two new dependencies are hard to avoid.** One is a Markdown renderer with a safe default (DM 5.4: "rendered with a strict sanitizer"). The other is Web Push's payload encryption (RFC 8291) and VAPID signing. Each is a decision (3 and 4).
8. **The moderation queue screen is wave 5,** which the roadmap puts in M8. M7 builds the queue, the actions and their audit, and reaches them through the Staff action workflow. M8 puts a screen on them.
9. **League threads aren't launch scope.** HLD §15 lists "league threads and pick reveal" as soon after launch, though DM 5.3 has a `league_id` column. M7 creates the column and no league threads.
10. **`src/identity/auth.ts` is 958 lines.** The roadmap's first M5 carry-over splits it before anything is added. M7 adds post and chat checks to `canPost`'s neighbours, not to `auth.ts`, but the split comes first as promised.
11. **Trust levels already count posts.** M5's `trust_thresholds` read `posts` and `reputation`, which are zero until M7 writes them. Task 15 feeds them.

## Decisions (yours)
These change what gets built. Each has my recommendation first.

1. **Approve DM Part 5.**
   - **Recommended: approve it as written, with this plan's changes.** The changes:
     - the chat refresh is viewer-independent (finding 2);
     - league threads wait (finding 9);
     - the moderation screen waits for M8 (finding 8).

     That also approves the retention in 5.10 and HLD §7.4's trust table (downvotes need TL1, TL0 can't start threads or post links). All of those are config except the chat rule.
   - **Alternative: review Part 5 part by part first,** as Parts 1–4 and 6 were. That's safer if you want to change the community's shape, and it delays M7 by the review.
2. **Search.**
   - **Recommended: after launch.** HLD §15 doesn't list it, and DM 5.12 says adding it later is purely additive: a generated `tsvector` column and a GIN index. M7 is the largest milestone, so leave it out.
   - **Alternative: build it in M7.** It's a task of about one day: the column, the index, a search page, and the spoiler and private-thread filters from 5.12.
3. **Markdown in posts.**
   - **Recommended: `micromark` (one dependency).** It's the CommonMark reference parser and escapes raw HTML by default. Our own step keeps links from the embed allow-list (HLD §7.1) and drops them for trust levels without links (§7.4). Its output is checked by tests that try script, `javascript:` links, images and raw HTML.
   - **Alternative: our own small subset** (bold, italic, links, quotes, lists, code), rendered to React elements. There's no dependency and no HTML string at all, but it's our parser to maintain, and people's Markdown from elsewhere renders oddly.
4. **Web Push.**
   - **Recommended: `web-push` (one dependency), plus a VAPID key pair you create.** `web-push` is the library most servers use for this. You run `pnpm dlx web-push generate-vapid-keys` once and enter `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` as secrets, as you did for Resend. I never see them. Without them push stays off and in-app notifications still work.
   - **Alternative: encryption by hand** with WebCrypto (about 150 lines of RFC 8291 and 8292), with no dependency. It's security code we'd own, tested only against the RFC's examples.
5. **Where chat archives live.**
   - **Recommended: a new `chat-archives` bucket** in gridlocked-staging's Object Storage, free, made by the deploy workflow on first run, with your OK. Production's comes with M9's production project.
   - **Alternative: a `chat/` prefix in the `exports` bucket.** No new resource, but one bucket then mixes keep-forever files with 7-day ones, and any rule that clears exports must step around chat.
6. **The chat load test.**
   - **Recommended: in M7, on staging, with your OK.** It's one Deploy staging run, then a script that sends 50 simulated readers refreshing every 3 seconds for 10 minutes. It counts CDN requests and function invocations, as the framework spike's staggered probe did. It uses about 10,000 of Hobby's 1M monthly CDN requests, and not on a race weekend.
   - **Alternative: fold it into M9's load tests.** M7 then ships chat without knowing whether the cache holds.
7. **Two M5 questions the roadmap left open.**
   - **A held username's look-alikes.**
     - **Recommended: no.** A name held for 90 days after a rename blocks that exact name. Look-alikes stay blocked only for reserved names, as now. Impersonating a held name is a report.
     - **Alternative: yes,** through `normalizeForCheck`, as reserved names are.
   - **`accountAgeDays` in the trust rules.**
     - **Recommended: keep it.** With posts counting from M7, it's what stops a day-old account reaching TL1 by posting ten times.
     - **Alternative: drop it,** and rely on days visited.

**My calls (lower stakes; each goes into the DM or UI brief when its task lands):**
- **Routes:**
  - `/forum` (categories) and `/forum/$category` (`?sort=hot|new`);
  - `/t/$threadId` (a thread, in chat mode or discussion mode by the clock), with `?post=` for "continue thread";
  - `/notifications`;
  - `/api/chat/$threadId` (the refresh).
- **The bottom nav becomes Home, Team, Forum, Leagues, Profile,** and the bell joins the header with an unread count. The desktop menu matches.
- **Categories** are seeded by the migration: Race Weekend (`race_weekend`), General, Fantasy (`fantasy`), Teams & Drivers, Technical, Silly Season and Off-topic, all `general` except as marked (HLD §7.1).
- **Session threads open on the Monday of event week** (HLD §7.2), at 00:00 UTC, one per session, in Race Weekend, with titles like "Qualifying — Discussion". A session's thread is in chat mode from 15 minutes before its start to 15 minutes after its end, and while it's `suspended`.
- **The results post** is written by the system account when the session's first scoring run finishes. It's a link to the weekend hub, not the result (wave 2: "Results are a link").
- **Chat limits (setting `chat_limits`):**
  - slow mode is 10 seconds for TL0, 5 for TL1 and none from TL2, and a moderator can raise it per thread;
  - 500 characters a message;
  - a refresh returns at most 50 messages after the cursor;
  - the window is 3 seconds.
- **Post limits (setting `post_limits`):**
  - TL0 gets 3 replies in 10 minutes;
  - TL1 gets 10 replies and 2 threads in 10 minutes;
  - TL2 and up get 30 replies and 5 threads;
  - links: none for TL0, 1 per post for TL1, unlimited from TL2;
  - at most 5 mentions a post;
  - the same body from one author in 24 hours is a duplicate.
- **Auto-hide:** report weight is 1 for TL0–1, 2 for TL2 and 5 for TL3 and moderators, and content hides at a total of 5 (setting `report_weights`). The roadmap's "a report flow and auto-hide" uses these.
- **Hot rank:** `log10(max(|score|, 1)) × sign(score) + created_at_seconds / 45000`, refreshed every 5 minutes for threads active in the last 48 hours.
- **Nesting:** replies indent 3 levels on a phone, then "Continue thread" (wave 2), whatever `depth` the data holds.
- **Notifications** are kept 90 days. The bell merges personal rows with broadcasts newer than `broadcasts_read_at` (DM 5.11). Push sends only personal kinds a person has on, plus "scores are in" broadcasts to people who turned that on.
- **Every push and notification text is spoiler-safe** when it carries a `session_id`. The text is rendered when shown, never stored (DM 5.11), and a push payload is always the safe version, because a lock screen can't ask whether you've watched.

## What each task needs from you
**Tasks 1–15 need no account and no key, and no staging write.** They're built and tested against PGlite and a local build, with push tested against a fake push service. Then:
- **Before Task 1:** decisions 1–7.
- **Task 14:** if you choose decision 4's recommendation, the VAPID key pair as two secrets (names only: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`), in the `staging` environment and in Vercel. Push stays off until they're set.
- **Task 16:**
  - one Deploy staging run, with your OK, not on a race weekend, which applies M7's migrations and, by decision 5, creates the `chat-archives` bucket;
  - the chat load test (decision 6), with its own OK.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). Server functions resolve it once with `withRequestNow`.
- **The database judges every write.** Counters (`reply_count`, `score`, `upvotes`) change in the same transaction as the post or vote. One open queue item per target and one vote per user per post are enforced by unique indexes, not by code.
- **Spoilers:** a response never carries a hidden session's posts, chat, results post or result-revealing notification text. Titles, `<title>`, toasts, notification text and push payloads use the spoiler-safe version until the viewer has revealed the session (DM 5.7's check).
- **Caching:**
  - every signed-in page and every server-function answer is `private, no-store`;
  - the chat refresh is `public, s-maxage=3`, reads no cookie, sets none and sends no `Vary`;
  - logged-out forum pages follow M6's public-page rule.
- **Guards:**
  - reading the forum needs nothing;
  - voting, reporting while signed in and marking as watched take `requireWritable`;
  - posting, chatting and starting threads take `canPost` (verified, active, not impersonated), then `checkPost`.
- **Refusals** come back as `{ ok: false, error: CommunityErrorCode }`, and the screen maps each to wave 4's copy. Anything else is `server_error`.
- **Untrusted text:** post bodies render only through Task 5's renderer. Chat, titles and usernames are plain text and never HTML.
- **Deleted users** show as "deleted user" wherever an author shows (DM 5.1). Nothing stores a username next to content.
- **UI** uses design-system components and tokens only, with targets of at least 44 px and body text of 16 px. Copy follows the canvases and the README's voice rules. No F1 marks.
- **Migrations:** schema in `src/db/schema/`, then `pnpm db:generate`; `pnpm db:drift` stays clean.
- **Workflow:** one branch `m7/<issue>-<slug>` and one PR per task, closing its issue. CI green before a squash-merge. No auto-merge, no force-push.

## Review Focus
1. **A spoiler leaks next to a hidden thread:**
   - a user thread's real title in a category list;
   - a reply notification's preview;
   - a push payload;
   - the page `<title>`;
   - the results post;
   - the chat refresh asked for by a page that hasn't revealed.

   Expected: none of them carries the result for a viewer who hasn't revealed the session. *Pinned in Tasks 6, 8, 10, 13 and 14.*
2. **Lights out.** Thirty people send at once and refresh every 3 seconds. Expected:
   - slow mode holds per person, on send and on insert;
   - a message never shows twice or goes missing across a window boundary or between two refreshes that land together;
   - the refresh is cached.

   *Pinned in Task 8.*
3. **An edit after a report.** Someone edits a reported post to look harmless, or deletes it. Expected: the queue item still holds the first text (`content_snapshot`), and a deleted post with replies leaves "[deleted]" with its replies in place. *Pinned in Tasks 5 and 11.*
4. **A restriction on an open page.** A muted or chat-banned user still has the composer open. Expected: the send is refused with words, and the restriction ends by itself at `until`. *Pinned in Tasks 4 and 12.*
5. **The session moves.** A delay, a red flag (`suspended`) or a cancellation. Expected:
   - chat mode follows the session's new times;
   - it stays open while suspended;
   - a cancelled session's thread goes to discussion mode and never gets a results post.

   *Pinned in Task 7.*

---

## Tasks at a glance
| # | Task | Size | Needs first |
|---|---|---|---|
| 1 | M5 carry-overs: split `auth.ts`, the export test, the trust and username rulings | S | |
| 2 | M5 carry-over: the scoring correction notice's open points | M | |
| 3 | Forum tables, `ltree` and the categories | M | |
| 4 | The posting gate | M | 3 |
| 5 | Threads, posts, edits, deletes, votes and Markdown | L | 4 |
| 6 | Forum screens: categories, thread lists, the thread page and the composer | L | 5 |
| 7 | Session threads, chat windows and results posts | M | 5 |
| 8 | Chat: send, slow mode, the refresh and the chat screen | L | 4, 7 |
| 9 | The chat archive, its replay, and archived chat in the export | M | 8 |
| 10 | Logged-out spoiler safety and the reveal toggle | M | 6, 8 |
| 11 | Reports, the queue and auto-hide | M | 5, 8 |
| 12 | Moderation actions and restrictions | M | 11 |
| 13 | Notifications, broadcasts and the bell | L | 5, 7 |
| 14 | Web Push and the app manifest | M | 13 |
| 15 | The community daily job: reputation, trust inputs, hot rank and retention | S | 5 |
| 16 | The exit: every flow, staging and the chat load test | M | everything |

Tasks 1, 2 and 3 touch nothing in common and can run alongside each other. After Task 5, Tasks 6, 7 and 15 are independent. Tasks 11 and 12 share `src/community/moderation.ts`, and 13 and 14 share `src/notifications/`, so each pair runs one at a time.

### Task 1: M5 carry-overs: split `auth.ts`, the export test, the trust and username rulings

**Files:**
- Modify: `src/identity/auth.ts`, into `src/identity/auth/` (`index.ts` re-exports the same names, then `options.ts`, `hooks.ts`, `email-hooks.ts` and `plugins.ts`, none over about 300 lines).
- Modify: `src/identity/export.test.ts`, `src/identity/usernames.ts` (only if decision 7 is "yes"), `src/settings/defaults.ts` (only if `accountAgeDays` goes), and DM 6.3 and 6.5.

**Interfaces:**
- Produces: the same exports from `@/identity/auth` as today. No caller changes an import.

- [ ] **Step 1: Pin the surface.** Add `auth.exports.test.ts`: the sorted list of `Object.keys(await import("@/identity/auth"))` equals today's list, written into the test.
- [ ] **Step 2: Split** along the file's existing sections. Run `pnpm test src/identity` and `pnpm typecheck`. Expected: green, with no other file changed except imports inside `src/identity/auth/`.
- [ ] **Step 3: Write the failing test** `expireExports marks a failed export expired and deletes no file` in `export.test.ts`, then make it pass if it fails. If it passes at once, the branch is already right: keep the test and record that in the PR.
- [ ] **Step 4: Apply decision 7.** "No" and "keep" change only DM 6.3 and 6.5's wording. "Yes" adds `a held name's look-alike is held` to `usernames.test.ts` first.
- [ ] **Step 5: Commit** `refactor: split auth.ts, and M5's open identity points`.

### Task 2: M5 carry-over: the scoring correction notice's open points

**Files:**
- Modify: `src/game/corrections.ts` and its tests, `src/scoring/` where the fixes land.

**Interfaces:**
- Consumes: `runInline`, `recomputeTotals` and `finishRun` as they are.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests:**
  - `a team that changes between two sessions' runs in one runInline is scored on its own lineup each time`;
  - `a crash between recomputeTotals and finishRun leaves the run retryable and the totals unchanged after the retry`;
  - `team_event_totals after a correction equal a fresh scoring of the same results`;
  - `a correction chain (results, then override, then ruleset_correction) ends at the same totals as scoring the final state once`.
- [ ] **Step 2: Run them.** Any that pass at once mean that point was already safe. Keep the test, and say so in the PR.
- [ ] **Step 3: Fix what fails,** with the smallest change in the function the failing test names.
- [ ] **Step 4: Run `pnpm test src/game src/scoring`.** Expected: green.
- [ ] **Step 5: Commit** `fix: the correction notice's open points from M5`.

### Task 3: Forum tables, `ltree` and the categories

**Files:**
- Create: `src/db/schema/community.ts`; one migration.
- Modify: `src/db/schema/index.ts`, `src/db/client.ts` and the test database helper (load `ltree`), DM Part 5's heading (drop "(proposed)" by decision 1).

**Interfaces:**
- Produces: tables `categories`, `threads`, `posts` (with `path ltree`), `post_revisions`, `post_mentions` and `post_votes`, as DM 5.2–5.4 and 5.6 list them. Also:
  - the CHECK lists as exported constants: `CATEGORY_KINDS`, `THREAD_KINDS`, `THREAD_STATUSES`, `POST_STATUSES`;
  - DM 5.13's indexes;
  - the seven seeded categories (my calls).

- [ ] **Step 1: Write the failing tests** in `src/db/community.test.ts`:
  - `the migration seeds seven categories in order`;
  - `a post's path loads its whole subtree in path order` (insert 1 → 2 → 3 and 1 → 4, then query `path <@ '1'`);
  - `a second vote by the same user on the same post is refused`;
  - `a thread kind outside the list is refused`.
- [ ] **Step 2: Add the schema, then run `pnpm db:generate`.** The migration starts `create extension if not exists ltree`. Drizzle has no `ltree` type, so a `customType` in `helpers.ts` declares it.
- [ ] **Step 3: Run the tests and `pnpm db:drift`.** Expected: green and clean.
- [ ] **Step 4: Commit** `feat: forum tables and categories`.

### Task 4: The posting gate

**Files:**
- Create: `src/community/gate.ts`, `src/community/gate.test.ts`, `src/community/errors.ts`; a migration for `user_restrictions` (DM 5.9).
- Modify: `src/settings/defaults.ts` (`post_limits`, `chat_limits`).

**Interfaces:**
- Consumes: `Viewer`, `filter_rules`, `getSetting`.
- Produces:
  - `type CommunityErrorCode = "trust_too_low" | "rate_limited" | "slow_mode" | "muted" | "chat_banned" | "thread_banned" | "too_many_links" | "links_not_allowed" | "too_many_mentions" | "duplicate" | "blocked" | "too_long" | "thread_locked" | "chat_closed" | "not_found" | "forbidden"`;
  - `checkPost(db, now, viewer, input: { kind: "thread" | "reply" | "chat"; threadId?: string; title?: string; body: string }): Promise<{ ok: true; hold: boolean; flags: FilterHit[]; spoilerTitle: boolean } | { ok: false; error: CommunityErrorCode; retryAfterSeconds?: number }>`;
  - `matchFilters(rules, scope, text): FilterHit[]`, pure;
  - `looksLikeSpoilerTitle(title, context: { driverNames: string[]; teamNames: string[] }): boolean`, pure. It's true for a driver or team name with a result word (win, wins, pole, P1–P20, podium, DNF, crash, retires).

- [ ] **Step 1: Write the failing tests,** with the values from my calls:
  - a TL0 viewer starting a thread gets `trust_too_low`;
  - a TL0 viewer's 4th reply in 10 minutes gets `rate_limited` with `retryAfterSeconds`;
  - a TL0 link gets `links_not_allowed`, and a TL1 post's second link gets `too_many_links`;
  - six mentions get `too_many_mentions`;
  - the same body twice in 24 hours gets `duplicate`;
  - an active `mute` restriction gets `muted`, and one whose `until` has passed allows the post;
  - a `block` filter refuses, a `hold_for_review` filter returns `hold: true`, and a `flag` filter returns its hit;
  - a TL0 chat message 4 seconds after the last gets `slow_mode`, with `retryAfterSeconds: 6`;
  - `looksLikeSpoilerTitle("Verstappen wins!")` is true, and `looksLikeSpoilerTitle("Who's watching qualifying?")` is false.
- [ ] **Step 2: Implement.** Rate limits count the viewer's own recent rows (DM 5.9), so there's no counter table. Restrictions are read in the same query as the profile's trust level.
- [ ] **Step 3: Run `pnpm test src/community`.** Expected: green.
- [ ] **Step 4: Commit** `feat: the posting gate`.

### Task 5: Threads, posts, edits, deletes, votes and Markdown

**Files:**
- Create: `src/community/threads.ts`, `src/community/posts.ts`, `src/community/votes.ts`, `src/community/render.ts` (decision 3), their tests; `src/server/community.ts`.

**Interfaces:**
- Consumes: `checkPost`, `canPost`, `requireWritable`.
- Produces:
  - `createThread(db, now, viewer, { categoryId, title, body, sessionId?, containsSpoilers })` returns `{ ok: true, threadId, status }` or a refusal. A held post (`hold`) is created `pending_review` and opens a queue item (Task 11 adds the queue; until then `hold` stores the status only).
  - `reply(db, now, viewer, { threadId, parentPostId?, body })`. It copies `session_id`, sets `path` and `depth`, updates `reply_count` and `last_activity_at`, and writes `post_mentions`.
  - `editPost(db, now, viewer, { postId, body })`. It writes a `post_revisions` row first, and runs the gate on the new body.
  - `deleteOwnPost(db, now, viewer, { postId })`. The body is cleared, the status becomes `deleted_by_author`, and replies stay.
  - `vote(db, now, viewer, { postId, value: 1 | -1 | 0 })`. TL0 can't downvote, and counters change in the same transaction.
  - `renderPost(markdown, { linksAllowed }): string`, safe HTML.
  - Server functions: `createThreadFn`, `replyFn`, `editPostFn`, `deletePostFn`, `voteFn`.

- [ ] **Step 1: Write the failing tests:**
  - `a reply three deep has depth 3 and its path ends in its own id`;
  - `an edit keeps the old text in post_revisions`;
  - `deleting a post with replies leaves "[deleted]" and the replies`;
  - `changing a vote from up to down moves score by -2 and thread score with it`;
  - `TL0 downvote is refused`;
  - `a mention of @late_braker writes one post_mentions row, and a mention of an unknown name writes none`.

  Render tests:
  - `<script>` comes out escaped;
  - a `javascript:` link has no `href`;
  - a YouTube link on the allow-list stays a link;
  - an unknown domain's link stays text for TL0.
- [ ] **Step 2: Implement,** each write in one transaction.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: threads, posts and votes`.

### Task 6: Forum screens: categories, thread lists, the thread page and the composer

**Files:**
- Create: `src/community/read.ts` (read models) and its tests; routes `forum.index.tsx`, `forum.$category.tsx`, `t.$threadId.tsx`; components `post-tree.tsx`, `composer.tsx`, `thread-row.tsx`.
- Modify: `src/components/ui/bottom-nav.tsx` and the desktop menu (Forum), the app shell.

**Interfaces:**
- Consumes: `revealedSessions`, Task 5's functions.
- Produces:
  - `categoryList(db)`;
  - `threadList(db, now, reader, { categorySlug, sort, cursor })`. Each row's title is the spoiler-safe one when its session is hidden for the reader.
  - `threadPage(db, now, reader, { threadId, postId? })` returns `{ thread, mode: "chat" | "discussion", hidden: boolean, posts: PostView[] }`. `posts` is empty when `hidden`.

- [ ] **Step 1: Write the failing tests** (read models, then Playwright at phone size):
  - `a hidden thread's list row shows its spoiler-safe title`;
  - `a hidden thread page returns no posts`;
  - `a reveal returns them`;
  - `a deleted author shows as "deleted user"`;
  - `replies deeper than 3 show "Continue thread"`;
  - e2e `post a reply and vote on it`;
  - e2e `a TL0 viewer sees no "New thread"`;
  - e2e `the spoiler title check offers "Contains spoilers for qualifying"`.
- [ ] **Step 2: Implement the screens** from wave 4's boards and wave 2's discussion board. Copy comes from the canvases.
- [ ] **Step 3: Run `pnpm test` and `pnpm e2e`.** Expected: green, with axe clean.
- [ ] **Step 4: Commit** `feat: the forum screens`.

### Task 7: Session threads, chat windows and results posts

**Files:**
- Create: `src/community/session-threads.ts` and its test.
- Modify: `src/jobs/kinds.ts` (`open_threads`, `results_post`), `src/jobs/plan-event.ts`, the scoring pipeline's run-finished step.

**Interfaces:**
- Produces:
  - `openSessionThreads(db, now, eventId)`. It's idempotent: one thread per session, with dedupe key `open_threads:<eventId>`.
  - `chatWindow(session, threadTimes): { opensAt; closesAt }`, pure (−15 min / +15 min).
  - `threadMode(now, session, thread): "chat" | "discussion"`, pure: chat inside the window or while `suspended`, and discussion otherwise and for a cancelled session.
  - `postResults(db, now, sessionId)`: one system post per session, skipped for cancelled sessions.
  - Moving a session updates its thread's `chat_opens_at` and `chat_closes_at` in the same transaction as the move.

- [ ] **Step 1: Write the failing tests:**
  - `event week opens one thread per session on Monday 00:00 UTC`;
  - `running the job twice makes no second thread`;
  - `a 30-minute delay moves the chat window`;
  - `a suspended session stays in chat mode past chat_closes_at`;
  - `a cancelled session's thread is discussion and gets no results post`;
  - `the results post is a link, and its thread is spoiler-scoped`.
- [ ] **Step 2: Implement,** planning `open_threads` with the event's other jobs.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: session threads and results posts`.

### Task 8: Chat: send, slow mode, the refresh and the chat screen

**Files:**
- Create: the `chat_messages` and `chat_archives` tables (one migration); `src/community/chat.ts`, `src/realtime/channel.ts`, `src/realtime/refresh.ts`, the route `api.chat.$threadId.ts`, the component `chat-view.tsx`; their tests.

**Interfaces:**
- Produces:
  - `sendChat(db, now, viewer, { threadId, body })`. The gate covers slow mode and limits, and the insert re-checks the window and slow mode.
  - `chatSince(db, threadId, afterId | null, limit = 50): ChatMessageView[]`.
  - `interface RealtimeChannel { subscribe(threadId, onMessages: (m: ChatMessageView[]) => void): () => void; send(threadId, body): Promise<SendResult> }`, and `createRefreshChannel({ windowSeconds: 3 })`.
  - **The refresh route:** `GET /api/chat/$threadId?after=<windowStartIso>`. It returns the latest 50 visible messages up to the end of the window, with `Cache-Control: public, s-maxage=3`, no `Vary`, no cookie read. The client drops ids it has already shown.

- [ ] **Step 1: Write the failing tests:**
  - `two messages in the same millisecond both arrive, in id order`;
  - `a message sent between two refreshes appears exactly once`;
  - `the refresh response has no Vary header and is public, s-maxage=3`;
  - `the refresh route never reads the session cookie` (a request with a cookie and one without return the same bytes);
  - `a send outside the chat window is refused with chat_closed`;
  - `a removed message disappears from the next refresh`;
  - e2e `slow mode shows "Wait 6s" and sends after it`;
  - e2e `a viewer who hasn't revealed the session never requests /api/chat` (Playwright request log).
- [ ] **Step 2: Implement.** The chat screen follows wave 2: flat, newest at the bottom, no bottom nav, and a send button that waits out slow mode.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: chat mode`.

### Task 9: The chat archive, its replay, and archived chat in the export

**Files:**
- Create: `src/community/archive.ts`, `src/providers/storage/chat-archive-store.ts` (decision 5) and their tests.
- Modify: `src/jobs/kinds.ts` (`chat_archive`), `src/identity/export.ts`, `src/identity/delete.ts`.

**Interfaces:**
- Produces:
  - `archiveThreadChat(db, store, now, threadId)`. It runs only when the thread's session ended 30 or more days ago. It writes gzip JSON lines of visible messages (`id`, `authorUserId`, `createdAt`, `body`), checks the count, inserts `chat_archives`, then deletes the rows, all retry-safe.
  - `archivedChat(store, threadId)` for the replay.
  - The export gains `chat_messages`: the person's own messages, live and archived. Deletion leaves archived lines as they are, because they hold only the user id, which becomes a tombstone (DM 5.1).

- [ ] **Step 1: Write the failing tests:**
  - `archiving 29 days after the session does nothing`;
  - `at 30 days the file holds every visible message and the rows are gone`;
  - `removed messages aren't archived`;
  - `a crash after the upload and before the delete is safe to run again`;
  - `the export lists a message that was archived`;
  - `the thread page replays the archive under the discussion`.
- [ ] **Step 2: Implement** with a memory store in tests, as `export-store.ts` does.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: the chat archive`.

### Task 10: Logged-out spoiler safety and the reveal toggle

**Files:**
- Create: `src/spoilers/browser-reveal.ts` and its test.
- Modify: the thread page and lists, the chat view, the weekend hub's logged-out view, the settings page (logged out: none).

**Interfaces:**
- Produces:
  - `browserReveal`: `get(): "safe" | "all"` and `set(v)`, on `localStorage` key `gridlocked:reveal`, read in a `try`/`catch`;
  - logged-out hidden content comes from a separate URL (`?show=1`), as M6's `/prices?show=changes` did, so the default page carries nothing hidden;
  - the toggle on the hidden thread: "Show results everywhere on this device".

- [ ] **Step 1: Write the failing tests:**
  - e2e logged out: `a race thread inside its window shows the safe title and no posts`;
  - `turning the toggle on shows them, and it survives a reload`;
  - `chat isn't requested until revealed`;
  - `the default thread page's HTML contains no post text`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: spoiler safety for visitors`.

### Task 11: Reports, the queue and auto-hide

**Files:**
- Create: the `reports` and `mod_queue_items` tables (one migration); `src/community/moderation.ts` (the queue half) and its test; the component `report-sheet.tsx`.
- Modify: `src/settings/defaults.ts` (`report_weights`), the gate's `hold` path (Task 5's TODO), the chat view and post menus.

**Interfaces:**
- Produces:
  - `report(db, now, reporter: Viewer | { contact: string; captchaToken: string }, { targetType, targetId, reason, note? })`. It's one report per reporter per target. It groups into one open queue item and adds weight; at the threshold it sets the target to `hidden_by_flags` (posts) or `removed` (chat), pending review.
  - `content_snapshot` is written when the item opens, and refreshed on an edit.
  - Logged-out reports need Turnstile and a contact address, which is deleted at resolution.

- [ ] **Step 1: Write the failing tests:**
  - `a second report by the same person changes nothing`;
  - `TL3's report alone auto-hides at weight 5`;
  - `five TL0 reports auto-hide`;
  - `the snapshot keeps the text after the author edits it`;
  - `a logged-out report without a captcha is refused`;
  - e2e `report a post from the "…" menu`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: reports and auto-hide`.

### Task 12: Moderation actions and restrictions

**Files:**
- Modify: `src/community/moderation.ts` (the actions half), `.github/workflows/staff-action.yml` and `src/staff/` (a `moderate` command), the profile page ("Actions on your account").
- Create: the `mod_actions` table.

**Interfaces:**
- Produces:
  - `moderate(db, now, staff: Viewer, { action, targetType, targetId, reason, until?, queueItemId?, version? })`, for every DM 5.9 action M7 needs: `remove`, `restore`, `lock`, `unlock`, `pin`, `unpin`, `move`, `retitle`, `warn`, `mute`, `unmute`, `chat_ban`. `ban` stays with Better Auth's admin plugin, mirrored as a row.
  - Each action writes `mod_actions` and `audit_log` with a reason, and resolving a queue item checks `version`.
  - The Staff action workflow's `moderate` command: a dry run first, then the real run.

- [ ] **Step 1: Write the failing tests:**
  - `two moderators resolving one item: the second gets a version conflict`;
  - `restore puts a hidden post back and logs it`;
  - `a mute until tomorrow refuses posts until then, then lifts`;
  - `every action writes an audit row with its reason`;
  - `retitle changes the spoiler-safe title only`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: moderation actions`.

### Task 13: Notifications, broadcasts and the bell

**Files:**
- Create: the `notifications`, `broadcasts` and `notification_preferences` tables (one migration); `src/notifications/` (`write.ts`, `read.ts`, `text.ts`) and tests; route `notifications.tsx`; the header bell.
- Modify: `src/jobs/kinds.ts` (`lock_reminder`); producers in `reply`, mentions, the roster change, lock reminders (one job per event lock, 24 hours and 1 hour before), the correction notice, `moderate` and league joins; `postResults` (a broadcast).

**Interfaces:**
- Produces:
  - `notify(tx, now, { userId, kind, groupKey?, actorUserId?, refs, data })`. One unread row per `groupKey`, counted in place.
  - `broadcast(tx, now, { gameId?, kind, sessionId?, eventId?, data })`.
  - `inbox(db, now, viewer, { cursor })` merges personal rows with broadcasts newer than `broadcasts_read_at`, and renders text with `notificationText(kind, data, revealed: boolean)`, pure.
  - `markRead(db, now, viewer, { ids | all })`.
  - `unreadCount(db, viewer)` for the bell.

- [ ] **Step 1: Write the failing tests:**
  - `five replies in one thread make one unread row with count 5`;
  - `"scores are in" is one broadcast row`;
  - `a score notification for a hidden session reads "Qualifying results are in"`;
  - `the same notification after Mark as watched names the result`;
  - `a turned-off kind writes no row`;
  - e2e `the bell shows 3, the list groups replies, opening it clears the count`.
- [ ] **Step 2: Implement,** with the copy from wave 4's Notifications board.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: notifications and the bell`.

### Task 14: Web Push and the app manifest

**Files:**
- Create: `public/manifest.webmanifest`, `public/sw.js` (push and notification click only, no offline cache), the `push_subscriptions` table, `src/notifications/push.ts` (decision 4) and its test, the push opt-in sheet, and a Push row in Settings.
- Modify: `src/jobs/kinds.ts` (`push_fanout`), the function's env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, declared only when both are set, like Resend's).

**Interfaces:**
- Produces:
  - `subscribe(db, now, viewer, { endpoint, p256dh, auth, userAgent })`;
  - `unsubscribe(...)`;
  - `fanOut(db, sender, now, { notificationIds })`: batched, at most 100 sends a job. A 404 or 410 deletes the subscription, and other failures add to `failure_count`.
  - `PushSender` is an interface, with a fake in tests.
  - The payload is always `notificationText(kind, data, revealed: false)`.

- [ ] **Step 1: Write the failing tests:**
  - `a 410 deletes the subscription`;
  - `three devices get three sends`;
  - `a payload for a session's score never names a result`;
  - `with no VAPID keys, fan-out sends nothing and logs a count`;
  - `the manifest has a name, icons and display standalone`.
- [ ] **Step 2: Implement.** The sheet follows wave 4's "Turn on push", and on iOS it says to add the app to the home screen first.
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: Web Push`.

### Task 15: The community daily job: reputation, trust inputs, hot rank and retention

**Files:**
- Create: `src/community/daily.ts` and its test.
- Modify: `src/jobs/kinds.ts` (`community_daily`, and `hot_rank` every 5 minutes), `src/identity/trust.ts` (it reads post counts), the profile page (recent posts).

**Interfaces:**
- Produces:
  - `recomputeReputation(db, now)`: from votes cast by TL1 and up only (DM 5.6).
  - `refreshHotRank(db, now)`: threads active in the last 48 hours, by my calls' formula.
  - `pruneCommunity(db, now)`:
    - revisions older than 1 year;
    - read notifications older than 90 days;
    - resolved reports, queue items and mod actions older than 2 years (DM 5.10).

- [ ] **Step 1: Write the failing tests:**
  - `a TL0 upvote adds no reputation`;
  - `ten posts and three days lift a user to TL1`;
  - `a 1-year-old revision is pruned and a 364-day one isn't`;
  - `hot rank orders a 50-point thread from today above a 60-point one from last week`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the tests.** Expected: green.
- [ ] **Step 4: Commit** `feat: the community daily job`.

### Task 16: The exit: every flow, staging and the chat load test

**Files:**
- Create: `e2e/community/weekend.spec.ts`, `scripts/chat-load.ts`.
- Modify: DM Part 5 (status lines per section), the UI brief's wave 4 notes, the roadmap's M7 result.

- [ ] **Step 1: Write the exit spec** at phone size on the replay-mode build. One weekend runs through:
  - the event week opening the threads;
  - a hidden qualifying thread, then Mark as watched;
  - chat with slow mode at the race;
  - the results post as a link;
  - a reply notification with spoiler-safe text, then the revealed text;
  - a report and auto-hide;
  - a moderator `restore` through the staff command;
  - a logged-out visitor's safe view and toggle;
  - the 30-day archive and its replay;
  - the export with archived chat.
- [ ] **Step 2: Fill the scenario table:** every DM 5.14 row and every wave 4 board names its test or its later milestone.
- [ ] **Step 3: The final whole-milestone review,** on the most capable model, and one fix pass.
- [ ] **Step 4: Deploy staging, with your OK** (not on a race weekend). It applies the migrations, creates the `chat-archives` bucket (decision 5) and deploys the site.
- [ ] **Step 5: The chat load test, with your OK** (decision 6). Run `scripts/chat-load.ts`: 50 readers, 3-second refreshes, staggered, 10 minutes, on one staging session thread opened by hand. Expected: function invocations of at most about 1 per 3-second window (about 200), with every response `x-vercel-cache: HIT` after the first in each window. Record both counts in the roadmap.
- [ ] **Step 6: Commit** `test: M7's exit` and `docs: M7's result`.

## Scenario coverage (Part 5 and the roadmap's key tests)
| Scenario (DM 5.14 or the roadmap) | Test |
|---|---|
| Event week starts | Task 7 `event week opens one thread per session…`, Task 16 |
| Session delayed or moved | Task 7 `a 30-minute delay moves the chat window` |
| Red flag runs long | Task 7 `a suspended session stays in chat mode…` |
| Chat flood at lights out | Task 8 refresh tests, Task 16 load test |
| User hasn't watched yet | Tasks 6, 8, 10, 13, 14 and 16 |
| Spoiler in a user's thread title | Task 4 `looksLikeSpoilerTitle`, Task 6 e2e, Task 12 `retitle` |
| Post edited after being reported | Task 11 `the snapshot keeps the text…` |
| Author deletes a post with replies | Task 5 |
| Account deleted | Task 6 `a deleted author shows as "deleted user"`, Task 9 |
| Spam wave of new accounts | Task 4 (TL0 limits, filters that hold), Task 11 |
| Vote brigading | Task 5 `TL0 downvote is refused`, Task 15 |
| Two moderators on one item | Task 12 |
| Moderator mistake | Task 12 `restore…` |
| Mute expires | Tasks 4 and 12 |
| Private league thread | Not in M7: league threads come after launch (finding 9) |
| Report from a logged-out visitor | Task 11 |
| Copyright notice | Task 11 (reason `copyright`), Task 12 (`remove`) |
| Chat reaches 30 days | Task 9 |
| "Scores are in" to everyone | Task 13 |
| Busy thread replies | Task 13 |
| Expired push subscription | Task 14 |
| Email cap reached | Done in M5 (finding 3) |
| Old thread revived | M8: auto-lock per category is a staff setting |
| Slow mode | Task 8 e2e |
| A data export including archived chat | Task 9, Task 16 |
| Search | Decision 2: after launch, unless you choose M7 |
