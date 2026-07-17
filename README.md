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
| `TELEGRAM_BOT_API_KEY`, `TELEGRAM_BOT_USERNAME` | Telegram bot |
| `R2_*` | Cloudflare R2 file uploads (optional) |

See `.env.example` for the full list.

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
