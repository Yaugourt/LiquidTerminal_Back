# Liquid Terminal Backend

REST API for the HyperLiquid ecosystem. It aggregates real-time market data, powers user portfolios, and serves the [Liquid Terminal](https://github.com/Yaugourt/liquidterminal_front) frontend and Telegram bot.

## Stack

Node.js 22 | Express 5 | TypeScript (strict) | Prisma 7 | PostgreSQL | Redis | Privy (auth)

## Features

- Real-time spot and perpetual market data (prices, volume, open interest, auctions)
- HIP-3 and HIP-4 analytics, EVM data, liquidations, vaults, and staking
- User accounts, multi-wallet management, and curated wallet lists
- Wiki, ecosystem projects, and an XP gamification system
- Streaming via WebSocket and SSE
- Redis caching, multi-tier rate limiting, and circuit breakers on external APIs

## Data sources

The API aggregates and normalizes several upstream providers:

- **HypeDexer** - primary real-time engine: HIP-3, HIP-4, EVM, analytics, fills, liquidations, top traders, TWAPs, vaults, and funding, over REST and WebSocket.
- **HyperLiquid** - spot and perpetual markets, token info, HLP vault, staking, and validators.
- **Hypurrscan** - auctions, fees, staking holders, and the unstaking queue.
- **DefiLlama** - token prices and protocol metrics.

## Getting started

### Prerequisites

- Node.js 22+
- PostgreSQL 14+ and Redis 6+
- A Privy app (App ID and secret)

### Setup

```bash
git clone git@github.com:Yaugourt/LiquidTerminal_Back.git
cd LiquidTerminal_Back
npm install
cp .env.example .env   # then fill in the values
```

The API uses four PostgreSQL databases (main, historical, content, telegram). Generate the Prisma clients and run the migrations for all of them:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

The server starts on `http://localhost:3002`. Check `GET /health` to confirm it is up.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Start the production build |
| `npm run lint` | ESLint (`lint:fix` to auto-fix) |
| `npm run type-check` | TypeScript check without emit |
| `npm run test` | Jest tests (`test:coverage` for coverage) |
| `npm run prisma:generate` | Generate Prisma clients (all databases) |
| `npm run prisma:migrate` | Deploy migrations (all databases) |
| `npm run prisma:studio` | Open Prisma Studio |

## Architecture

```
src/
├── app.ts          # Express app + route registration
├── core/           # Singletons: Prisma, Redis, cache, circuit breaker
├── clients/        # Upstream API clients (HypeDexer, HyperLiquid, Hypurrscan, DefiLlama)
├── services/       # Business logic (domain-organized)
├── routes/         # HTTP handlers (domain-organized)
├── repositories/   # Data access (Prisma)
├── middleware/     # Auth, rate limiting, validation, security
├── schemas/        # Zod validation
└── types/          # TypeScript definitions
```

Request flow: `middleware (auth, rate limit, validation) -> route -> service -> repository/client`.

Responses follow a standard envelope:

```jsonc
// success
{ "success": true, "data": {}, "pagination": {} }
// error
{ "success": false, "error": "message", "code": "ERROR_CODE" }
```

Authenticated routes expect a Privy JWT in the `Authorization: Bearer <token>` header.

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL`, `HISTORICAL_DATABASE_URL`, `CONTENT_DATABASE_URL`, `TELEGRAM_DATABASE_URL` | PostgreSQL connections |
| `REDIS_URL` | Redis connection |
| `JWKS_URL`, `NEXT_PUBLIC_PRIVY_AUDIENCE`, `FIRST_ADMIN_PRIVY_USER_ID` | Privy authentication |
| `ALLOWED_ORIGINS`, `PORT`, `NODE_ENV` | Server config |
| `HL_INDEXER_API_KEY` | HypeDexer / HL indexer access |
| `HYPEDEXER_DAILY_CREDIT_BUDGET` | HypeDexer credits a UTC day before a warning is logged (optional, default 300000; warning only) |
| `HYPERFOLIO_API_KEY` | Hyperfolio access: required for `/hyperfolio/*` (Yields page, tracker EVM panels), which answer 503 `HYPERFOLIO_NOT_CONFIGURED` without it |
| `HYPERFOLIO_DAILY_BUDGET` | Upstream Hyperfolio calls a UTC day, all instances together (optional, default 50000; a guess of the paid quota, set it to the real one) |
| `RATE_LIMIT_BURST`, `RATE_LIMIT_MINUTE`, `RATE_LIMIT_HOUR` | Per-IP ceilings of the general limiter (optional, defaults 200/s, 6000/min, 300000/h; sized for many people behind one IP) |
| `PASSTHROUGH_RATE_LIMIT_BURST`, `PASSTHROUGH_RATE_LIMIT_MINUTE` | Per-IP ceilings of the `/indexer/*` pass-through limiter (optional, defaults 300/s, 4000/min) |
| `ADDRESS_LOOKUP_RATE_LIMIT_BURST`, `ADDRESS_LOOKUP_RATE_LIMIT_MINUTE` | Per-IP ceilings of the Elysium address / contract profile lookups (optional, defaults 20/s, 300/min) |
| `CACHE_LAST_COPY_MAX_S`, `CACHE_LAST_COPY_MAX_CHARS` | A cached value's last copy (served when a refresh fails, and when a live key's refresh is slow) is kept ~10 TTLs, at most this many seconds or 2 TTLs (optional, default 600); copies of non-live keys longer than the character cap are skipped (default 262144) |
| `CACHE_LIVE_REFRESH_WAIT_MS` | How long a reader of an expired live key (TTL ≤ 30 s) waits for its refresh before getting the last copy (optional, default 1500) |
| `CACHE_SHARED_LAST_COPY_S` | Keep of the last copy for shared fixed-name keys that opt in (dashboard tiles, builders stats, HIP-4 tokens): how long an upstream outage still shows their last values (optional, default 3600) |
| `HYPERFOLIO_STREAMS_PER_IP`, `HYPERFOLIO_STREAMS_TOTAL` | Concurrent Hyperfolio positions streams (optional, defaults 30 per IP, 500 in all) |
| `WS_MAX_CONNECTIONS_PER_IP`, `WS_MAX_TOTAL_CONNECTIONS` | `/ws` connections (optional, defaults 200 per IP, 10000 in all) |
| `L4BOOK_MAX_COINS` | Order books mirrored at once (optional, default 48) |
| `BRIDGE_RESERVE_MAX_WEIGHT_PER_CYCLE` | Hyperliquid weight the bridge-reserve scan spends a minute (optional, default 60) |
| `TELEGRAM_BOT_API_KEY`, `TELEGRAM_BOT_USERNAME` | Telegram bot |
| `R2_*` | Cloudflare R2 file uploads (optional) |

See `.env.example` for the full list.

## Deploy

1. **Deploy the backend before the frontend.** The front calls routes that only exist from this release on (`/market/token-details`, `/market/holders`, `/market/twap`, `/market/revenue/af-buybacks`, `/liquidations/historical/top`, `/hyperfolio/*`) and has no fallback for their absence.
2. **Environment.** Set `HYPERFOLIO_API_KEY` before the deploy (without it the Yields page and the tracker EVM panels fail). `HYPERFOLIO_DAILY_BUDGET` and `HYPEDEXER_DAILY_CREDIT_BUDGET` are optional. `CACHE_LAST_COPY_MAX_BYTES` was renamed `CACHE_LAST_COPY_MAX_CHARS`.
   **Redis memory.** Check `redis-cli CONFIG GET maxmemory*`: set a `maxmemory` limit with `maxmemory-policy volatile-ttl` (or `volatile-lru`), not `noeviction` nor `allkeys-*` (see [docs/DATABASE_ARCHITECTURE.md](docs/DATABASE_ARCHITECTURE.md#redis-memory)). The backend assumes one instance per outbound IP for its Hyperliquid weight budget.
3. **Historical migration.** `20260924120000_repair_doubled_liquidation_time_ms` repairs liquidations stored with a doubled `time_ms` (dated around 2083), which every "since X" window counts. It is data-only, touches a handful of rows through the time index, and is idempotent. Check before and after:

   ```sql
   SELECT count(*) FROM raw_liquidations WHERE time > now() + interval '1 day';
   ```

   Apply it with `npm run prisma:migrate:historical` (also part of `prisma:migrate:predeploy`). If the count is still above 0 after the new code is live (the old ingestion stored a doubled row after the migration ran), run the migration's SQL again by hand: Prisma will not apply it a second time.
4. **Smoke tests** once the backend is live (each should answer 200 with data):

   ```bash
   curl -s "$API/hyperfolio/yield?page=1&page_size=5"                       # not 503 HYPERFOLIO_NOT_CONFIGURED
   curl -s "$API/market/token-details/0x0d01dc56dcaaca66ad901c959b4011ec"  # HYPE supply
   curl -s "$API/market/holders/HYPE?page=1&limit=10"
   curl -s "$API/market/twap?status=active"
   curl -s "$API/market/revenue/af-buybacks"
   curl -s "$API/liquidations/historical/top?period=24h&min_amount_dollars=100000&limit=3"
   ```

   Then deploy the frontend.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution guidelines
- [SECURITY.md](SECURITY.md) - security policy
- [DATABASE_ARCHITECTURE.md](DATABASE_ARCHITECTURE.md) - multi-database design
- [docs/CLIENT_ARCHITECTURE.md](docs/CLIENT_ARCHITECTURE.md) - external clients
- [docs/WEBSOCKET_API.md](docs/WEBSOCKET_API.md) and [docs/FRONTEND_SSE_INTEGRATION.md](docs/FRONTEND_SSE_INTEGRATION.md) - streaming
- [docs/TELEGRAM_BOT_INTEGRATION.md](docs/TELEGRAM_BOT_INTEGRATION.md) - Telegram bot

## Links

- Frontend: [liquidterminal_front](https://github.com/Yaugourt/liquidterminal_front)
- Website: [liquidterminal.xyz](https://liquidterminal.xyz)
- X: [@LiquidTerminal](https://x.com/liquidterminal)

## License

MIT. See [LICENSE](LICENSE).
