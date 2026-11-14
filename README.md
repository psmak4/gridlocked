# Gridlocked

An unofficial F1 fan community and fantasy game.

## Prerequisites

- Node 24 (see `.nvmrc`)
- pnpm 10, via corepack: `corepack enable`

## Run

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000.

## Checks

```sh
pnpm lint          # ESLint, zero warnings allowed
pnpm typecheck     # tsc --noEmit
pnpm format:check  # Prettier (use `pnpm format` to fix)
pnpm build         # production build (Vite; `pnpm start` runs it from .output/)
pnpm test          # Vitest unit and database tests (in-memory PGlite)
pnpm e2e           # Playwright end-to-end tests
pnpm db:generate   # generate a migration after editing src/db/schema
pnpm db:drift      # fail if the schema and src/db/migrations disagree
```

Before the first `pnpm e2e`, install the browser once:

```sh
pnpm exec playwright install chromium
```

`pnpm e2e` runs two Playwright projects on the same `VITE_LOCAL_DB=1` build:

- `chromium` (port 3100): everything outside `e2e/fantasy/`, on the system
  clock;
- `fantasy` (port 3101, `CLOCK_MODE=replay`): the specs in `e2e/fantasy/`, one
  at a time. Each seeds the recorded 2026 game with `seedGame` and moves the
  simulated clock with `moveClock` (`e2e/helpers/game.ts`), so the real lock,
  scoring, finalize and price jobs run on recorded results. Run it alone with
  `pnpm e2e --project=fantasy --workers=1`.

## Staging

The results pipeline runs on the Neon project `gridlocked-staging` (branch
`main`): a Neon Function, `tick`, fired by two schedule triggers declared in
[`neon.ts`](neon.ts), one every minute and a safety run every six hours. The
function code is [`src/jobs/functions/tick.ts`](src/jobs/functions/tick.ts).

The **Deploy staging** workflow (`.github/workflows/deploy-staging.yml`) puts
the code there. It is manual only and uses the `staging` environment's
secrets `DATABASE_URL_STAGING` (the direct, unpooled URL of the `main`
branch) and `NEON_API_KEY_STAGING`. Its steps:

1. install with the frozen lockfile;
2. `pnpm db:migrate:staging`: apply the migrations and list the ones applied;
3. `pnpm import:2026`, only if the `import_2026` input is ticked; it refuses a
   database that has already polled live data;
4. `neon config plan`, then `neon deploy` (a pinned `neon` CLI): the
   `scheduler` bucket, the `tick` function and its two triggers;
5. print the function URL and the trigger ids (never a secret);
6. the website, only if the `staging` secret `VERCEL_TOKEN` is set (otherwise
   a notice says it was skipped): `NITRO_PRESET=vercel pnpm build`, a check
   that `.vercel/output` has `config.json` and no PGlite or other local-only
   code, then `vercel deploy --prebuilt --prod` (a pinned `vercel` CLI).

To run it, merge to `main` and then:

```sh
gh workflow run deploy-staging.yml -f import_2026=true   # first deploy
gh workflow run deploy-staging.yml                       # later deploys
```

The same scripts work from a shell with a database URL in the environment:
`DATABASE_URL=... pnpm db:migrate` and `DATABASE_URL=... pnpm import:2026`
(`--dry-run` imports into an in-memory database and needs no URL). Never put
a connection string or API key in a file or a commit.

### The staging website

The site is a Vercel project, `gridlocked-staging` (Hobby), deployed by the
workflow above. Create each value yourself; none of them goes in a file, a
commit, a chat or an issue.

In GitHub, under Settings, Environments, `staging`:

| Name                      | Kind     | What it is                                                   |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `VERCEL_TOKEN`            | secret   | An access token from your Vercel account settings            |
| `VERCEL_ORG_ID`           | variable | The team or account id (Vercel project settings)             |
| `VERCEL_PROJECT_ID`       | variable | The id of `gridlocked-staging` (same page)                   |
| `VITE_TURNSTILE_SITE_KEY` | variable | The Turnstile widget's site key (public, used at build time) |
| `RESEND_API_KEY`          | secret   | The Resend key, for the tick                                 |
| `EMAIL_FROM`              | secret   | `onboarding@resend.dev`, for the tick                        |

In Vercel, under the project's Settings, Environment Variables (Production):

| Name                                         | What it is                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                         | The output of `openssl rand -base64 32`                                                                        |
| `BETTER_AUTH_URL`                            | `https://gridlocked-staging.vercel.app`                                                                        |
| `SIGN_UP_ALLOWED_EMAILS`                     | Your Resend account address: on staging, only it can sign up                                                   |
| `DATABASE_URL`                               | The staging pooled connection string                                                                           |
| `RESEND_API_KEY`                             | The Resend key                                                                                                 |
| `EMAIL_FROM`                                 | `onboarding@resend.dev`                                                                                        |
| `TURNSTILE_SECRET_KEY`                       | The Turnstile widget's secret key                                                                              |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The Discord application; its redirect URL is `https://gridlocked-staging.vercel.app/api/auth/callback/discord` |

Until `VERCEL_TOKEN` is set, Deploy staging skips the website steps and
everything else works as before. Run it only with your OK, and not on a race
weekend. A local check of the same build needs no account:
`NITRO_PRESET=vercel pnpm build`, then look in `.vercel/output`.

### Staff actions

Until the staff screens (M8), a driver swap or a result correction is
recorded with `pnpm staff` (`scripts/staff.ts`), on staging through the
manual **Staff action** workflow (`.github/workflows/staff-action.yml`):

- `substitute`: one event only. The substitute gets an admin entry, and the
  replaced driver is marked unavailable.
- `seats`: from an event onward. Race seats close and open.
- `override`: one driver's result in one session, for provider data that is
  wrong and stays wrong. A `patch` override sets the given `results` columns
  over the provider row.
- `set-role`: a user's role (`user`, `moderator` or `admin`), by username,
  with no event. It refuses `system` and demoting the last active admin, and
  signs the user out everywhere so the new role holds at once. Its output
  shows only the username and the role change.

A new admin or moderator still can't open staff tools until they turn on an
authenticator app (TOTP) and enter a code once in that session (DM 6.4).

Each write goes to `audit_log` with the reason and the GitHub login of
whoever ran it. For the roster and result commands the event is then checked
again, so a held session moves straight away. The workflow does a dry run unless `dry_run` is unticked:

```sh
gh workflow run staff-action.yml -f command=substitute -f event=2026/19 \
  -f change='{"in":"ryo_hirakawa","team":"haas","car":99,"out":"ocon"}' \
  -f reason='Hirakawa replaces Ocon from FP3'

gh workflow run staff-action.yml -f command=set-role \
  -f change='{"username":"ada","role":"moderator"}' \
  -f reason='Helps run race chat'
```

## Docs

Design, planning and decisions live in [`docs/`](docs/).
