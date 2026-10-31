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
5. print the function URL and the trigger ids (never a secret).

To run it, merge to `main` and then:

```sh
gh workflow run deploy-staging.yml -f import_2026=true   # first deploy
gh workflow run deploy-staging.yml                       # later deploys
```

The same scripts work from a shell with a database URL in the environment:
`DATABASE_URL=... pnpm db:migrate` and `DATABASE_URL=... pnpm import:2026`
(`--dry-run` imports into an in-memory database and needs no URL). Never put
a connection string or API key in a file or a commit.

## Docs

Design, planning and decisions live in [`docs/`](docs/).
