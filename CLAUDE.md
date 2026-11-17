# CLAUDE.md: Liquid Terminal backend

Instructions for AI agents working in this repo. This is the only instruction file: keep it short and true. A version or a figure is read in the code (`package.json`, `Dockerfile`, `docs/DATA_BUDGET.md`), never copied from memory.

## Project

The API behind Liquid Terminal (REST, plus a WebSocket and SSE feeds). It gathers Hyperliquid market data, runs the Elysium ingestion and analytics, and serves the account features: wallet lists, read lists, XP, wiki content, alerts sent through the Telegram bot. The web app lives in a separate repo (`liquidterminal_front`).

## Stack

Majors below, exact versions in `package.json`.

| Area | Technology |
|------|------------|
| Runtime | Node.js 22 (`engines`, `Dockerfile`, CI), npm (lockfile `package-lock.json`) |
| Framework | Express 5 |
| Language | TypeScript 5, strict mode |
| Databases | PostgreSQL through Prisma 7, four schemas (see Databases) |
| Cache, limits, locks | Redis (ioredis 5) |
| Validation | Zod 4 |
| Auth | Privy JWT, verified with `jose` |
| Tests | Jest 30 |
| Logs | pino 9, through `logDeduplicator` |

## Commands

```bash
npm ci                    # install from the lockfile
npm run prisma:generate   # the four Prisma clients; needed before type-check and build
npm run dev               # dev server with reload
npm run lint              # ESLint
npm run type-check        # tsc --noEmit
npm test                  # Jest, mocks only, no database
npm run test:db           # SQL tests on a real Postgres (needs TEST_HISTORICAL_DATABASE_URL,
                          # a database of its own: the tests empty it)
npm run build             # tsc to dist/
npm run prisma:migrate    # migrate deploy on the four schemas
```

CI (`.github/workflows/ci.yml`) has two jobs: `build` (generate, type check, build, tests) and `db` (the SQL tests on Postgres).

Environment variables are listed in `.env.example`. In `.env`, comments start with `#`, and `REDIS_URL` is defined once, with a real address.

## Structure

```
src/
├── app.ts          # Express app, route registration
├── core/           # shared services: Prisma (x4), Redis, cache, circuit breaker, scheduler, locks
├── clients/        # one folder per upstream API, built on BaseApiService
├── services/       # business logic, one folder per domain
├── routes/         # HTTP handlers, one folder per domain
├── repositories/   # data access (Prisma)
├── middleware/     # auth, rate limits, validation, body limits, security
├── schemas/        # Zod schemas
├── websocket/      # the /ws server
├── types/  errors/  constants/  utils/
prisma/  prisma-historical/  prisma-content/  prisma-telegram/   # one schema + migrations each
tests/              # unit/, integration/, db/ (real Postgres), fixtures/
docs/               # DATA_BUDGET.md, ELYSIUM_RUNBOOK.md, CLIENT_ARCHITECTURE.md, ...
.agents/            # vendored third-party agent tooling: not our source
```

Request path: middleware (auth, rate limit, validation) → route → service → repository or client → response.

## Read before you work

| File | When |
|------|------|
| `docs/DATA_BUDGET.md` | Before changing a poll interval, cache TTL, rate limit or upstream budget. Update it in the same commit (an identical copy lives in the frontend repo) |
| `docs/ELYSIUM_RUNBOOK.md` | When the Elysium ingestion needs a hand: a stopped stream, a day that differs, the volume filling up, going back |
| `docs/CLIENT_ARCHITECTURE.md` | Before adding or changing an upstream client |
| `docs/DATABASE_ARCHITECTURE.md` | Before touching a schema |
| `docs/WEBSOCKET_API.md` | The `/ws` contract |
| `SECURITY.md`, `CONTRIBUTING.md` | Reporting and contribution rules |
| `CHANGELOG.md` | What was delivered, in plain words |

## Rules

### Workflow

- Every change goes through a branch, then a pull request. Never push to `main`: a push to `main` goes to production (Railway), and there is no staging environment.
- Every PR adds its line to `CHANGELOG.md` under `[Unreleased]` when the change is visible to a user of the site or of the API.
- Before opening a PR: `npm run lint`, `npm run type-check`, `npm run build` and `npm test` pass.
- A change that the frontend depends on is deployed here first.
- Commit only the files of the task, not the whole working tree. Do not run a formatter over files you did not change.

### Writing

- English in code, comments, commit messages and docs.
- Never name a competitor or the private data indexer in code, comments, commits or shared documents. Write "the data indexer" and "an analytics site". Older code and docs still contain such names: do not add new ones.
- Nothing invented: a figure has a source (API, Hyperliquid docs, a measurement) or it is not written.

### Code

- Types: explicit types on public functions, `z.infer` for validated inputs, no `any` (`unknown` when truly unknown).
- Files are named `domain.service.ts`, `domain.routes.ts`, `domain.schema.ts`.
- Services and clients are singletons (`getInstance()`). CRUD services extend `BaseService` (`src/core/crudBase.service.ts`).
- An upstream client extends `BaseApiService` (`src/core/base.api.service.ts`: time limits, retries, circuit breaker, rate limit) and is registered in `ClientInitializerService`.
- Responses: `{ success: true, data, message?, pagination? }` or `{ success: false, error, code }`.
- Every input is validated with Zod. GET routes use `validateGetRequest` (query and params only); `validateRequest` is for routes with a JSON body.
- Routes get a rate limiter, and auth (`validatePrivyToken`) plus `requireRole` where needed. Roles: `USER`, `MODERATOR`, `ADMIN`.
- Domain errors are classes in `src/errors/`, turned into the error response by the route.
- Log through `logDeduplicator` (`src/utils/logDeduplicator.ts`), never `console.log`.
- Cache through the cache service, with keys and TTLs declared in `src/constants/`. Limits and TTLs are documented in `docs/DATA_BUDGET.md`.
- Database writes that go together run in `transactionService.execute(...)`.
- No secrets in code. User-submitted URLs are checked before any fetch (`src/utils/ssrf.ts`).

### Indexer routes (`src/routes/indexer/`)

GET-only pass-through to the data indexer, which bills each call. Schemas live in `src/schemas/indexer/`. A missing required parameter must fail here with a 400, not upstream. Anything new on these routes is counted in `docs/DATA_BUDGET.md`.

### Tests

- A change to a statement of the Elysium ingestion or views gets a test in `tests/db` (`npm run test:db`).
- Other tests are mock-based and live in `tests/unit` and `tests/integration`.

## Databases

Four Prisma schemas, each with its own client, migrations and connection variable:

| Schema | Variable | Holds |
|--------|----------|-------|
| `prisma/` | `DATABASE_URL` | users, wallets, wallet lists, read lists, XP |
| `prisma-historical/` | `HISTORICAL_DATABASE_URL` | liquidations history, Elysium tables |
| `prisma-content/` | `CONTENT_DATABASE_URL` | projects, wiki resources, public goods |
| `prisma-telegram/` | `TELEGRAM_DATABASE_URL` | Telegram users, subscriptions and sent alerts |

- A Prisma command on a schema other than `prisma/` takes both `--schema` and `--config` (see the `prisma:*` scripts in `package.json`).
- The Prisma CLI needs the Node version of `engines`.
- No foreign key crosses two databases: join in code.
- Paginate every `findMany`, select only the columns you need on large tables, and index the columns you filter on.

## Gotchas

- `prisma.config.ts` reads `DATABASE_URL` when it loads: even `prisma generate` needs it set (a dummy value is enough).
- `PROCESS_ROLE=elysium-worker` makes a process run the Elysium ingestion on its own (`src/utils/env.ts`).
- The SQL tests empty the database they are given: never point `TEST_HISTORICAL_DATABASE_URL` at real data.
