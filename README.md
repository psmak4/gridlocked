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
pnpm build         # production build
pnpm test          # Vitest unit and database tests (in-memory PGlite)
pnpm e2e           # Playwright end-to-end tests
pnpm db:generate   # generate a migration after editing src/db/schema
pnpm db:drift      # fail if the schema and src/db/migrations disagree
```

Before the first `pnpm e2e`, install the browser once:

```sh
pnpm exec playwright install chromium
```

## Docs

Design, planning and decisions live in [`docs/`](docs/).
