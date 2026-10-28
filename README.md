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
```

## Docs

Design, planning and decisions live in [`docs/`](docs/).
