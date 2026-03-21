# Client Architecture - Complete Guide

## Overview

This documentation explains the complete client architecture in the application, from API clients to routes, including services and middlewares.

## General Structure

```
src/
├── clients/           # External API clients
├── core/             # Base services and utilities
├── services/         # Business layer
├── routes/           # API entry points
├── middleware/       # Validation, auth, etc. middlewares
├── repositories/     # Data access
├── types/           # TypeScript types
└── schemas/         # Zod validation schemas
```

## 1. Client Layer (src/clients/)

### Client Structure

All clients inherit from `BaseApiService` and follow the Singleton pattern:

```typescript
// BaseApiService provides:
- fetchWithTimeout<T>() : timeout management
- withRetry() : retry mechanism
- post<T>() / get<T>() : HTTP methods
- handleError() : error handling
```

### Client Types

#### A. Hyperliquid Clients (src/clients/hyperliquid/)
- **Spot**: `HyperliquidSpotClient`
- **Perp**: `HyperliquidPerpClient`
- **Vault**: `HyperliquidVaultClient`, `HyperliquidVaultsClient`
- **Staking**: `ValidatorClient`
- **Deploy**: `HyperliquidSpotDeployClient`
- **Token Info**: `HyperliquidTokenInfoClient`
- **Stats**: `HyperliquidSpotStatsClient`, `HyperliquidGlobalStatsClient`

#### B. Hypurrscan Clients (src/clients/hypurrscan/)
- **Auction**: `HypurrscanClient`
- **Validation**: `HypurrscanValidationClient`
- **Unstaking**: `HypurrscanUnstakingClient`
- **Spot USDC**: `SpotUSDCClient`
- **Fees**: `HypurrscanFeesClient`

### Standard Client Pattern

```typescript
export class ExampleClient extends BaseApiService {
  private static instance: ExampleClient;
  private static readonly API_URL = 'https://api.example.com';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  // Cache and polling
  private readonly CACHE_KEY = 'example:data';
  private readonly UPDATE_CHANNEL = 'example:updated';
  private readonly UPDATE_INTERVAL = 10000;
  private pollingInterval: NodeJS.Timeout | null = null;

  // Integrated services
  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(ExampleClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('example');
    this.rateLimiter = RateLimiterService.getInstance('example', {
      maxWeightPerMinute: ExampleClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: ExampleClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): ExampleClient {
    if (!ExampleClient.instance) {
      ExampleClient.instance = new ExampleClient();
    }
    return ExampleClient.instance;
  }

  public startPolling(): void {
    // Polling logic with Redis caching
  }

  private async updateData(): Promise<void> {
    // Data retrieval and caching
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
}
```

## 2. Client Initialization

### ClientInitializerService

The `ClientInitializerService` centralizes initialization:

```typescript
// In src/core/client.initializer.service.ts
export class ClientInitializerService {
  private static instance: ClientInitializerService;
  private clients: Map<string, any> = new Map();

  public initialize(): void {
    // Initialize all clients
    const spotClient = HyperliquidSpotClient.getInstance();
    this.clients.set('spot', spotClient);
    
    // ... other clients
    
    // Start polling for all
    this.startAllPolling();
  }
}
```

### Integration into the Application

```typescript
// In src/app.ts
const clientInitializer = ClientInitializerService.getInstance();
clientInitializer.initialize();
```

## 3. Service Layer (src/services/)

### Standard Service Pattern

Services use the Singleton pattern and often inherit from `BaseService` :

```typescript
export class ExampleService extends BaseService<
  ResponseType, 
  CreateInputType, 
  UpdateInputType, 
  QueryParamsType
> {
  private static instance: ExampleService;
  protected repository = exampleRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.EXAMPLE;
  protected validationSchemas = {
    create: createSchema,
    update: updateSchema,
    query: querySchema
  };
  protected errorClasses = {
    notFound: ExampleNotFoundError,
    alreadyExists: ExampleAlreadyExistsError,
    validation: ExampleValidationError
  };

  public static getInstance(): ExampleService {
    if (!ExampleService.instance) {
      ExampleService.instance = new ExampleService();
    }
    return ExampleService.instance;
  }
}
```

### Service Types

#### A. Business Services
- **Market Data**: `SpotAssetContextService`, `PerpAssetContextService`
- **Staking**: `ValidationService`, `UnstakingService`
- **Vault**: `VaultsService`
- **Auth**: `AuthService`
- **Wallet**: `WalletService`
- **Project**: `ProjectService`, `CategoryService`

#### B. Utility Services
- **Global Stats**: `DashboardGlobalStatsService`
- **Fees**: `FeesService`
- **Bridged USDC**: `BridgedUsdcService`

### Client-Service Connection

```typescript
// Example: Service using a client
export class ExampleService {
  private readonly client: ExampleClient;
  
  constructor() {
    this.client = ExampleClient.getInstance();
    this.setupSubscriptions(); // Listen for client updates
  }
  
  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, (message) => {
      // Process client updates
    });
  }
}
```

## 4. Route Layer (src/routes/)

### Route Structure

```
src/routes/
├── auth.routes.ts          # Authentication
├── globalStats.routes.ts   # Global stats
├── health.routes.ts        # App health
├── spot/                   # Spot routes
│   ├── marketSpot.routes.ts
│   ├── spotStats.routes.ts
│   └── auction.routes.ts
├── perp/                   # Perp routes
├── vault/                  # Vault routes
├── staking/                # Staking routes
├── wallet/                 # Wallet routes
├── project/                # Project routes
├── educational/            # Educational routes
└── fees/                   # Fees routes
```

### Standard Route Pattern

```typescript
import { Router, Request, Response, RequestHandler } from 'express';
import { ExampleService } from '../services/example.service';
import { marketRateLimiter } from '../middleware/apiRateLimiter';
import { validatePrivyToken } from '../middleware/authMiddleware';
import { validateRequest } from '../middleware/validation/validation.middleware';
import { exampleSchema } from '../schemas/example.schema';

const router = Router();
const exampleService = ExampleService.getInstance();

// Global middlewares for all routes
router.use(marketRateLimiter);

// Route with validation and authentication
router.post('/example', 
  validatePrivyToken,                    // Auth middleware
  validateRequest(exampleSchema),        // Validation middleware
  (async (req: Request, res: Response) => {
    try {
      const result = await exampleService.create(req.body);
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      // Standard error handling
      if (error instanceof ExampleError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

export default router;
```

## 5. Middleware Layer (src/middleware/)

### Middleware Types

#### A. Authentication
```typescript
// src/middleware/authMiddleware.ts
export const validatePrivyToken = (req: Request, res: Response, next: NextFunction): void => {
  // Privy token validation
  // req.user injection
}
```

#### B. Validation
```typescript
// src/middleware/validation/validation.middleware.ts
export const validateRequest = (schema: AnyZodObject): RequestHandler => {
  // Zod validation
  // Caching of validations
}
```

#### C. Rate Limiting
```typescript
// src/middleware/apiRateLimiter.ts
export const marketRateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Multi-level rate limiting (burst, minute, hour)
  // Redis for counting
}
```

#### D. Security
```typescript
// src/middleware/security.middleware.ts
export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Security headers (CSP, HSTS, etc.)
}
```

#### E. Sanitization
```typescript
// src/middleware/validation/sanitization.middleware.ts
export const sanitizeInput = (req: Request, res: Response, next: NextFunction) => {
  // User input sanitization
}
```

## 6. Complete Data Flow

### Example: Spot Markets Route

```
1. Client makes a request → GET /api/spot/markets
2. Middlewares applied:
   - securityHeaders
   - marketRateLimiter
   - sanitizeInput
3. Route handler called
4. Service SpotAssetContextService.getMarkets()
5. Service reads from Redis (client cache)
6. If cache empty, trigger client update
7. HyperliquidSpotClient makes API call
8. Data processed and cached
9. Service returns data
10. Route returns JSON response
```

### Polling and Updates

```
1. Client starts polling (setInterval)
2. Client makes external API call
3. Data processed and stored in Redis
4. Message published on Redis channel
5. Subscribed services receive notification
6. Local caches updated if necessary
```

## 7. Error Handling

### Error Hierarchy

```typescript
// Base errors
export class BaseError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
}

// Domain-specific errors
export class SpotError extends BaseError {}
export class PerpError extends BaseError {}
export class VaultError extends BaseError {}
// etc.
```

### Error Handling in Routes

```typescript
try {
  const result = await service.method();
  res.json({ success: true, data: result });
} catch (error) {
  if (error instanceof DomainError) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR'
  });
}
```

## 8. Patterns and Best Practices

### A. Singleton Pattern
- All major clients and services
- Avoid multiple instances
- Share state and resources

### B. Circuit Breaker
- Protection against failed external APIs
- Fail-fast in case of issues
- Automatic recovery

### C. Rate Limiting
- Protection against abuse
- IP and endpoint-based limits
- Multi-level (burst, minute, hour)

### D. Caching Strategy
- Redis for distributed cache
- Intelligent invalidation
- Appropriate TTLs based on data

### E. Polling Strategy
- Optimized intervals by data type
- Error handling with retry
- Avoiding concurrent calls

## 9. How to Add a New Route

### Standard Steps

1. **Create the Client** (if necessary)
```typescript
// src/clients/provider/new.client.ts
export class NewClient extends BaseApiService {
  // Standard pattern
}
```

2. **Create the Service**
```typescript
// src/services/new.service.ts
export class NewService extends BaseService {
  // Standard pattern
}
```

3. **Create the Repository** (if database)
```typescript
// src/repositories/new.repository.ts
export class NewRepository implements BaseRepository {
  // CRUD operations
}
```

4. **Create Types**
```typescript
// src/types/new.types.ts
export interface NewData {
  // Data structure
}
```

5. **Create Schemas**
```typescript
// src/schemas/new.schema.ts
export const newSchema = z.object({
  // Zod validation
});
```

6. **Create Routes**
```typescript
// src/routes/new.routes.ts
const router = Router();
const newService = NewService.getInstance();

router.use(marketRateLimiter);

router.get('/', async (req, res) => {
  // Handler
});

export default router;
```

7. **Integrate into the App**
```typescript
// src/app.ts
import newRoutes from './routes/new.routes';
app.use('/api/new', newRoutes);
```

8. **Add to ClientInitializer** (if client)
```typescript
// src/core/client.initializer.service.ts
const newClient = NewClient.getInstance();
this.clients.set('new', newClient);
```

## 10. Debugging and Monitoring

### Logs
- `logDeduplicator` to avoid duplicate logs
- Structured logs with context
- Appropriate levels (info, warn, error)

### Metrics
- Rate limiting by IP
- API response times
- Errors by endpoint
- Cache utilization

### Health Checks
- Route `/health` to check status
- External service checks
- Client and connection status

This architecture allows for easy extensibility and simplified maintenance. Each layer has its responsibility and patterns are consistent across the application. 