# Agent memory

## Learned User Preferences

- Debugging and explanations are often requested in French.

## Learned Workspace Facts

- `prisma-historical` requires `HISTORICAL_DATABASE_URL` in `.env`; local dev typically uses a dedicated Postgres database for historical data, with migrations run against `prisma-historical/schema.prisma` and `prisma-historical/prisma.config.ts`.
- `.env` must define at most one effective `REDIS_URL`—duplicate keys usually mean the last value wins; placeholder URLs with hostname `host` break Redis; for local dev use a real URL such as `redis://localhost:6379` and run Redis for cache and rate limiting.
- In `.env`, use lines starting with `#` for comments; plain text lines without `#` can be misparsed as variable assignments.
- Two Prisma schemas live side-by-side: `prisma/` and `prisma-historical/`; run **`prisma migrate status`** on both (historical uses `--schema` and `--config` under `prisma-historical/`). Prisma 7 CLI needs a Node version matching the repo's `engines` and the `prisma` package (often **Node 22.x**); older Node can surface `ERR_REQUIRE_ESM` when the CLI loads `@prisma/dev` (e.g. `require` vs ESM on `zeptomatch`).
