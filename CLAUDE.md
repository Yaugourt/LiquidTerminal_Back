# CLAUDE.md - LiquidTerminal Backend Guidelines

## Project Overview

LiquidTerminal Backend is a production-grade REST API for the HyperLiquid trading ecosystem. It aggregates real-time market data, manages user portfolios, and provides educational/gamification features.

**Stack**: Node.js 20 | Express 5 | TypeScript (strict) | Prisma 7 | PostgreSQL | Redis | Privy Auth

---

## Quick Commands

```bash
npm run dev              # Development server with hot reload
npm run build            # Production build
npm run build:clean      # Clean + build
npm run lint             # ESLint check
npm run lint:fix         # Auto-fix linting issues
npm run type-check       # TypeScript check without build
npm run test             # Run Jest tests

# Database
npm run prisma:generate  # Generate Prisma client
npm run prisma:migrate   # Run migrations (dev)
npm run prisma:studio    # Open Prisma Studio GUI
```

---

## Architecture Overview

```
src/
├── app.ts                    # Express app + route registration
├── core/                     # Singleton services (Prisma, Redis, Cache, CircuitBreaker)
├── clients/                  # External API clients (HyperLiquid, Hypurrscan, HLIndexer)
├── services/                 # Business logic layer (domain-organized)
├── routes/                   # HTTP handlers (domain-organized)
├── repositories/             # Data access layer (Prisma implementations)
├── middleware/               # Auth, rate limiting, validation, security
├── schemas/                  # Zod validation schemas
├── types/                    # TypeScript definitions
├── errors/                   # Domain-specific error classes
├── constants/                # Application constants
└── utils/                    # Logging, cleanup utilities
```

### Data Flow
```
HTTP Request → Middleware (auth, rate limit, validation) → Route → Service → Repository/Client → Response
```

---

## Key Patterns

### 1. Singleton Pattern (All Clients & Services)
```typescript
export class ExampleService {
  private static instance: ExampleService;

  public static getInstance(): ExampleService {
    if (!ExampleService.instance) {
      ExampleService.instance = new ExampleService();
    }
    return ExampleService.instance;
  }
}
```

### 2. BaseService Pattern
Services extend `BaseService` for CRUD operations with built-in caching and validation.

### 3. API Client Pattern
External clients extend `BaseApiService` providing:
- `fetchWithTimeout<T>()` - Timeout management
- `withRetry()` - Automatic retries with backoff
- Circuit breaker integration
- Rate limiting per client

### 4. Response Format
```typescript
// Success
{ success: true, data: T, message?: string, pagination?: {...} }

// Error
{ success: false, error: string, code: "ERROR_CODE" }
```

---

## Code Conventions

### Naming
- **Files**: `domain.service.ts`, `domain.routes.ts`, `domain.schema.ts`
- **Variables/Functions**: camelCase
- **Classes/Types**: PascalCase
- **Constants**: UPPER_SNAKE_CASE
- **Prisma Enums**: PascalCase (`UserRole`, `ResourceStatus`)

### Import Order
1. Node.js native modules
2. External dependencies (express, zod, etc.)
3. Core/lib internal modules
4. Types/Schemas/Errors
5. Services/Repositories

### TypeScript
- **Always** explicit types on public function parameters and returns
- Use Zod inference: `type Input = z.infer<typeof schema>`
- **Avoid** `any` - use `unknown` if type is truly unknown
- Strict mode is enabled

---

## Adding New Features

### New Endpoint Checklist
1. Create Zod schema in `schemas/domain.schema.ts`
2. Create types in `types/domain.types.ts`
3. Create error classes in `errors/domain.errors.ts`
4. Create/update repository in `repositories/`
5. Implement service logic in `services/domain/`
6. Create validation middleware
7. Create route with auth + validation + rate limiting
8. Add to `app.ts` route registration
9. Add appropriate logging with `logDeduplicator`
10. Add Redis cache if data is frequently accessed
11. Write tests

### New External API Client
1. Create client in `clients/provider/name.client.ts`
2. Extend `BaseApiService`
3. Implement singleton pattern
4. Add circuit breaker and rate limiter
5. Register in `ClientInitializerService`
6. Implement polling if real-time data needed

---

## Database (Prisma)

### Schema Location
`prisma/schema.prisma`

### Key Models
- **User** - Privy auth, roles (USER/MODERATOR/ADMIN), XP tracking
- **Wallet** - Ethereum addresses
- **UserWallet** - User-wallet junction with custom names
- **WalletList** - Curated wallet collections
- **EducationalResource** - Wiki content with moderation status
- **Project** - Ecosystem projects with categories
- **XpTransaction** - Gamification transactions

### Best Practices
- Use `include` for relations, avoid N+1 queries
- Always use `select` for large tables to avoid over-fetching
- Add `@@index` for frequently filtered columns
- Use transactions via `transactionService.executeTransaction()`
- Pagination required for `findMany` operations

### Migrations
```bash
npx prisma migrate dev --name short_description  # Development
npx prisma migrate deploy                         # Production
```

---

## Authentication & Authorization

### Auth Flow
1. Frontend authenticates via Privy (Web3 wallet)
2. JWT token sent in `Authorization: Bearer <token>` header
3. `validatePrivyToken` middleware validates and extracts `req.user.sub` (privyUserId)

### Roles
```typescript
enum UserRole { USER, MODERATOR, ADMIN }
```
Use `requireRole(UserRole.MODERATOR)` middleware for protected routes.

---

## Caching (Redis)

### Cache Prefixes
Defined in `constants/cache.constants.ts`

### TTL Guidelines
- Market data: 10-60 seconds
- User data: 1-5 minutes
- Static content: 1 hour
- Liquidation data: 60 seconds

### Pattern
```typescript
const cached = await cacheService.get<T>(key);
if (cached) return cached;

const data = await fetchData();
await cacheService.set(key, data, ttlSeconds);
return data;
```

---

## Rate Limiting

### Tiers
- **Burst**: 20 requests/second
- **Minute**: 1,200 requests/minute
- **Hour**: 72,000 requests/hour

### Middlewares
- `marketRateLimiter` - Standard API rate limiting
- `contributionRateLimiter` - Stricter limits for write operations (5/day)

---

## Error Handling

### Custom Error Classes
Each domain has its own error classes in `errors/`:
```typescript
export class WalletNotFoundError extends BaseError {
  constructor() {
    super('Wallet not found', 404, 'WALLET_NOT_FOUND');
  }
}
```

### Route Error Handling
```typescript
try {
  const result = await service.method();
  res.json({ success: true, data: result });
} catch (error) {
  if (error instanceof DomainError) {
    return res.status(error.statusCode).json({
      success: false, error: error.message, code: error.code
    });
  }
  res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
}
```

---

## External APIs

### HyperLiquid (`clients/hyperliquid/`)
- Spot market data, token info, asset context
- Perpetual market data
- Vault data (HLP)
- Staking/validator info

### Hypurrscan (`clients/hypurrscan/`)
- Auction data
- Fee statistics
- Validation metrics
- Unstaking queue

### HL Indexer (`clients/hlindexer/`)
- Liquidation data with background polling

---

## Security Checklist

- [ ] All user inputs validated with Zod
- [ ] Rate limiting applied to route
- [ ] Auth middleware for protected routes
- [ ] Role check for admin/moderator features
- [ ] No secrets in code (use env vars)
- [ ] SQL injection prevented (Prisma handles this)
- [ ] XSS prevented (sanitizeInput middleware)
- [ ] HTTPS enforced for user-submitted URLs

---

## Logging

Use `logDeduplicator` from `utils/logDeduplicator.ts`:
```typescript
logDeduplicator.info('Action completed', { userId, resourceId });
logDeduplicator.error('Error occurred', { error, context });
logDeduplicator.warn('Warning condition', { details });
```

---

## Environment Variables

Required in `.env`:
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...
ALLOWED_ORIGINS=https://liquidterminal.xyz
NODE_ENV=development|production
PORT=3002
```

Optional (for file uploads):
```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_ENDPOINT=...
```

---

## Testing

### Structure
```
tests/
├── unit/services/       # Service unit tests
├── integration/routes/  # Route integration tests
└── fixtures/            # Mock data
```

### Running Tests
```bash
npm run test              # All tests
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report
```

---

## Common Tasks

### Debug a slow endpoint
1. Check for N+1 queries (add `include` or use `select`)
2. Verify Redis cache is being used
3. Check if external API calls can be parallelized
4. Review database indexes for filtered columns

### Add caching to an endpoint
1. Define cache key in constants
2. Check cache before DB/API call
3. Set cache after fetching with appropriate TTL
4. Invalidate cache on writes if needed

### Handle a new external API
1. Create client extending `BaseApiService`
2. Add circuit breaker for fault tolerance
3. Implement rate limiting if API has limits
4. Add Redis caching for responses
5. Consider background polling for real-time data