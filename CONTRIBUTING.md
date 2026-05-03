# Contributing

## Prerequisites

- Node.js 20+
- pnpm 9+
- Redis (for BullMQ workers)
- SQLite (bundled via Prisma)

## Setup

```bash
pnpm install
cp .env.example .env   # fill in required values
pnpm db:push
pnpm exec prisma generate
```

## Development

Run the dashboard locally:

```bash
pnpm dashboard        # http://localhost:3030
```

Run workers individually:

```bash
pnpm worker:scan
pnpm worker:enrich
pnpm worker:ai
pnpm worker:action
```

## Typecheck

```bash
pnpm typecheck
```

CI runs this automatically on every push and pull request.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Dutch court case scraper
fix: handle null email in enrichment
chore: bump playwright to 1.49
```

Common prefixes: `feat`, `fix`, `chore`, `ci`, `docs`, `refactor`.

## Branching

- `main` — production-ready code
- `feature/<name>` — new features
- `fix/<name>` — bug fixes

Open a pull request against `main`. CI must pass before merging.

## Environment variables

See `.env.example` for all required variables. Never commit `.env` or any real API keys.
