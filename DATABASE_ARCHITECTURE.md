# Database Architecture - Complete Guide

## Overview

This documentation explains the complete database access architecture, from Prisma models through repositories, services, and up to routes. It covers every layer, its patterns, and how they connect.

## General Structure

```
src/
├── core/
│   ├── prisma.service.ts          # PrismaClient singleton (main DB)
│   ├── prisma.historical.service.ts # PrismaClient singleton (historical DB)
│   ├── crudBase.service.ts        # Abstract BaseService for CRUD
│   ├── transaction.service.ts     # Transactional wrapper
│   ├── cache.service.ts           # Redis cache-aside pattern
│   └── redis.service.ts           # Redis connection & operations
├── repositories/
│   ├── interfaces/                # Repository contracts (interfaces)
│   ├── prisma/                    # Prisma implementations
│   └── index.ts                   # Singleton instances & exports
├── services/                      # Business logic (domain-organized)
├── routes/                        # HTTP handlers (domain-organized)
├── schemas/                       # Zod validation schemas
├── types/                         # TypeScript type definitions
├── errors/                        # Domain-specific error classes
├── middleware/                    # Auth, validation, rate limiting
└── constants/
    └── cache.constants.ts         # Cache prefixes, TTLs, key builders
```

## Complete Data Flow

```
HTTP Request
    │
    ▼
Express Global Middleware
  compression → requestId → cors → securityHeaders → bodyParser → sanitizeInput
    │
    ▼
Route Matching (app.ts)
  app.use('/category', categoryRoutes)
    │
    ▼
Route-Level Middleware Chain
  marketRateLimiter → validatePrivyToken → requireModerator → validateRequest(schema)
    │
    ▼
Route Handler (routes/domain/domain.routes.ts)
  Parses params, calls service, formats response
    │
    ▼
Service Layer (services/domain/domain.service.ts)
  Validates with Zod, checks cache, wraps in transaction, calls repository
    │
    ▼
Repository Layer (repositories/prisma/prisma.domain.repository.ts)
  Pure Prisma operations, pagination helpers, error wrapping
    │
    ▼
Prisma Client → PostgreSQL
    │
    ▼
Response bubbles back up with cache population & error mapping
```

---

## 1. Prisma Service (src/core/)

### Main Database

```typescript
// src/core/prisma.service.ts
class PrismaService {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!PrismaService.instance) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const adapter = new PrismaPg(pool);
      PrismaService.instance = new PrismaClient({ adapter, log: ['error', 'warn'] });
      PrismaService.instance.$connect();
    }
    return PrismaService.instance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaService.instance) {
      await PrismaService.instance.$disconnect();
    }
  }
}

export const prisma = PrismaService.getInstance();
```

### Historical Database (separate DB)

```typescript
// src/core/prisma.historical.service.ts
// Same singleton pattern, uses HISTORICAL_DATABASE_URL
// Generated client from prisma-historical/generated/client
export const prismaHistorical = PrismaHistoricalService.getInstance();
```

**Key points:**
- Uses `@prisma/adapter-pg` with `pg.Pool` for connection pooling
- Singleton pattern ensures one connection pool per DB
- Graceful disconnect on SIGINT/SIGTERM via `app.ts`

---

## 2. Repository Layer (src/repositories/)

### Base Repository Interface

```typescript
// src/repositories/interfaces/base.repository.interface.ts
export interface BaseRepository {
  setPrismaClient(prismaClient: Omit<PrismaClient, ...>): void;
  resetPrismaClient(): void;
}
```

These two methods enable **transaction support**: the service injects a transactional client before operations, then resets after.

### Base Prisma Repository

```typescript
// src/repositories/prisma/base-prisma.repository.ts
export abstract class BasePrismaRepository {
  protected prismaClient: any = prisma;  // Default: singleton

  // Transaction support
  setPrismaClient(prismaClient: any): void;
  resetPrismaClient(): void;

  // Helpers
  protected async executeWithErrorHandling<T>(operation, operationName, context?): Promise<T>;
  protected buildPagination(total, page, limit): BasePagination;
  protected validatePaginationParams(params): void;
  protected buildWhereClause(params): any;   // search, userId, isPublic, etc.
  protected buildQueryParams(params): { skip, take, orderBy };
}
```

**`executeWithErrorHandling`** wraps every DB call with structured logging:
```typescript
protected async executeWithErrorHandling<T>(
  operation: () => Promise<T>,
  operationName: string,
  context?: any
): Promise<T> {
  try {
    const result = await operation();
    return result;
  } catch (error) {
    logDeduplicator.error(`Error in ${operationName}`, { error, context });
    throw error;
  }
}
```

**`buildPagination`** returns a standard pagination object:
```typescript
{
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
```

### Domain Repository Interface

Each domain defines its own interface extending `BaseRepository`:

```typescript
// src/repositories/interfaces/category.repository.interface.ts
export interface CategoryRepository extends BaseRepository {
  findAll(params: { page?, limit?, sort?, order?, search? }): Promise<{ data: CategoryResponse[]; pagination: BasePagination }>;
  findById(id: number): Promise<CategoryResponse | null>;
  findByIdWithProjects(id: number): Promise<CategoryWithProjects | null>;
  create(data: CategoryCreateInput): Promise<CategoryResponse>;
  update(id: number, data: CategoryUpdateInput): Promise<CategoryResponse>;
  delete(id: number): Promise<void>;
  existsByName(name: string): Promise<boolean>;
}
```

### Prisma Implementation

```typescript
// src/repositories/prisma/prisma.category.repository.ts
export class PrismaCategoryRepository extends BasePrismaRepository implements CategoryRepository {

  async findAll(params) {
    return this.executeWithErrorHandling(async () => {
      this.validatePaginationParams(params);
      const where = this.buildWhereClause({ search: params.search });
      const { skip, take, orderBy } = this.buildQueryParams(params);

      const total = await this.prismaClient.category.count({ where });
      const categories = await this.prismaClient.category.findMany({ where, skip, take, orderBy });

      return {
        data: categories,
        pagination: this.buildPagination(total, params.page ?? 1, params.limit ?? 10)
      };
    }, 'finding all categories', { page: params.page });
  }

  async create(data: CategoryCreateInput) {
    return this.executeWithErrorHandling(
      async () => this.prismaClient.category.create({ data }),
      'creating category',
      { name: data.name }
    );
  }
}
```

### Singleton Instances

```typescript
// src/repositories/index.ts
export const projectRepository: ProjectRepository = new PrismaProjectRepository();
export const categoryRepository: CategoryRepository = new PrismaCategoryRepository();
export const walletRepository = new WalletRepository();
// ... more repositories
```

All repositories are instantiated once and imported by services.

---

## 3. Service Layer (src/services/)

### BaseService (Abstract CRUD)

```typescript
// src/core/crudBase.service.ts
export abstract class BaseService<T, CreateInput, UpdateInput, QueryParams extends BaseQueryParams> {
  protected abstract repository: any;
  protected abstract cacheKeyPrefix: string;
  protected abstract validationSchemas: {
    create: z.ZodSchema<CreateInput>;
    update: z.ZodSchema<UpdateInput>;
    query: z.ZodSchema<QueryParams>;
  };
  protected abstract errorClasses: {
    notFound: new (message?: string) => Error;
    alreadyExists: new (message?: string) => Error;
    validation: new (message?: string) => Error;
  };

  // Provided methods (inherited by all services)
  async getAll(query: QueryParams);
  async getById(id: number);
  async create(data: CreateInput);
  async update(id: number, data: UpdateInput);
  async delete(id: number);

  // Cache helpers
  protected async invalidateEntityCache(id: number): Promise<void>;
  protected async invalidateEntityListCache(): Promise<void>;
  protected validateInput<T>(data: T, schema: z.ZodSchema<T>): T;

  // Must be implemented by subclasses
  protected abstract checkExists(data: CreateInput): Promise<boolean>;
  protected abstract checkExistsForUpdate(id: number, data: UpdateInput): Promise<boolean>;
  protected abstract checkCanDelete(id: number): Promise<void>;
}
```

### BaseService Method Details

#### `getAll(query)`
```
1. Validate query params with Zod → validationSchemas.query
2. Build cache key: `${cacheKeyPrefix}:list:${JSON.stringify(validatedQuery)}`
3. cacheService.getOrSet(key, () => repository.findAll(validatedQuery), CACHE_TTL.MEDIUM)
4. Return { data: T[], pagination: BasePagination }
```

#### `getById(id)`
```
1. Cache key: `${cacheKeyPrefix}:${id}`
2. cacheService.getOrSet(key, () => repository.findById(id), CACHE_TTL.MEDIUM)
3. Throw errorClasses.notFound if null
4. Return T
```

#### `create(data)`
```
1. Validate input with Zod → validationSchemas.create
2. transactionService.execute(async (tx) => {
     repository.setPrismaClient(tx);
     if (await checkExists(validatedData)) throw alreadyExists;
     return repository.create(validatedData);
   });
3. repository.resetPrismaClient();
4. Cache new entity
5. Invalidate list cache
6. Return T
```

#### `update(id, data)`
```
1. Validate input with Zod → validationSchemas.update
2. transactionService.execute(async (tx) => {
     repository.setPrismaClient(tx);
     if (!await repository.findById(id)) throw notFound;
     if (await checkExistsForUpdate(id, validatedData)) throw alreadyExists;
     return repository.update(id, validatedData);
   });
3. repository.resetPrismaClient();
4. Invalidate entity + list cache
5. Return T
```

#### `delete(id)`
```
1. transactionService.execute(async (tx) => {
     repository.setPrismaClient(tx);
     if (!await repository.findById(id)) throw notFound;
     await checkCanDelete(id);
     await repository.delete(id);
   });
2. repository.resetPrismaClient();
3. Invalidate entity + list cache
```

### Concrete Service Example

```typescript
// src/services/project/category.service.ts
export class CategoryService extends BaseService<
  CategoryResponse,
  CategoryCreateInput,
  CategoryUpdateInput,
  CategoryQueryParams
> {
  protected repository = categoryRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.CATEGORY;
  protected validationSchemas = {
    create: categoryCreateSchema,
    update: categoryUpdateSchema,
    query: categoryQuerySchema
  };
  protected errorClasses = {
    notFound: CategoryNotFoundError,
    alreadyExists: CategoryAlreadyExistsError,
    validation: CategoryValidationError
  };

  protected async checkExists(data: CategoryCreateInput): Promise<boolean> {
    return await this.repository.existsByName(data.name);
  }

  protected async checkExistsForUpdate(id: number, data: CategoryUpdateInput): Promise<boolean> {
    if (data.name) {
      const category = await this.repository.findById(id);
      if (category && data.name !== category.name) {
        return await this.repository.existsByName(data.name);
      }
    }
    return false;
  }

  protected async checkCanDelete(id: number): Promise<void> {
    const projects = await projectRepository.findAll({ categoryIds: [id] });
    if (projects.data.length > 0) {
      throw new CategoryValidationError('Cannot delete category with associated projects');
    }
  }

  // Custom domain methods beyond CRUD:
  async getCategoryWithProjects(id: number) { ... }
  async getProjectsByCategory(categoryId: number) { ... }
}
```

---

## 4. Transaction Service (src/core/transaction.service.ts)

```typescript
export class TransactionService {
  async execute<T>(
    operation: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | ...>) => Promise<T>
  ): Promise<T> {
    const result = await this.prismaClient.$transaction(operation, {
      timeout: 10000  // 10 seconds
    });
    return result;
  }
}

export const transactionService = new TransactionService();
```

**Usage pattern in services:**
```typescript
const entity = await transactionService.execute(async (tx) => {
  this.repository.setPrismaClient(tx);    // Inject transactional client
  // ... all DB operations use tx
  return this.repository.create(data);
});
this.repository.resetPrismaClient();      // Reset to default singleton
```

- Auto-commits on success, auto-rolls back on error
- 10-second timeout prevents long-running transactions
- `isTransactionInProgress` flag warns against nesting

---

## 5. Cache Layer (src/core/cache.service.ts)

### Cache Service

```typescript
export class CacheService {
  async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl: number): Promise<T>;
  async invalidate(key: string): Promise<void>;
  async invalidateByPattern(pattern: string): Promise<void>;
}

export const cacheService = new CacheService();
```

### Cache Constants

```typescript
// src/constants/cache.constants.ts
export const CACHE_PREFIX = {
  PROJECT: 'project',
  CATEGORY: 'category',
  WALLET: 'wallet',
  LIQUIDATIONS: 'liquidations',
  // ...
} as const;

export const CACHE_TTL = {
  SHORT: 60,     // 1 minute — frequently changing data
  MEDIUM: 300,   // 5 minutes — default
  LONG: 3600     // 1 hour — static content
} as const;

export const CACHE_KEYS = {
  PROJECT: (id: number) => `${CACHE_PREFIX.PROJECT}:${id}`,
  PROJECT_LIST: (params: string) => `${CACHE_PREFIX.PROJECT}:list:${params}`,
  CATEGORY: (id: number) => `${CACHE_PREFIX.CATEGORY}:${id}`,
  CATEGORY_LIST: (params: string) => `${CACHE_PREFIX.CATEGORY}:list:${params}`,
  // ...
} as const;
```

### Cache Strategy

- **Read path**: `getOrSet(key, fetchFn, ttl)` — returns cached data or fetches + caches
- **Write path**: `invalidateEntityCache(id)` + `invalidateEntityListCache()` — clears entity + all list caches
- **Pattern invalidation**: `invalidateByPattern("project*")` — wildcard key deletion
- **Graceful degradation**: On Redis failure, falls back to database directly

---

## 6. Types (src/types/)

Each domain defines its TypeScript types:

```typescript
// src/types/project.types.ts
export interface CategoryResponse {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryCreateInput {
  name: string;
  description?: string;
}

export interface CategoryUpdateInput {
  name?: string;
  description?: string;
}

export interface CategoryWithProjects extends CategoryResponse {
  projects: { id: number; title: string; desc: string; logo: string; ... }[];
}
```

### Common Types

```typescript
// src/types/common.types.ts
export interface BasePagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: BasePagination;
}
```

---

## 7. Zod Schemas (src/schemas/)

### Schema Pattern

Each domain has **3 schemas**: `create`, `update`, `query`.

```typescript
// src/schemas/category.schema.ts
export const categoryCreateSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(100, 'Le nom ne doit pas dépasser 100 caractères')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-_]+$/, 'Le nom contient des caractères non autorisés'),
  description: z.string()
    .max(255, 'La description ne doit pas dépasser 255 caractères')
    .trim()
    .optional()
});

export const categoryUpdateSchema = categoryCreateSchema.partial();

export const categoryQuerySchema = z.object({
  page: z.string().transform(val => parseInt(val))
    .pipe(z.number().int().positive()).optional().default(1),
  limit: z.string().transform(val => parseInt(val))
    .pipe(z.number().int().positive().max(1000)).optional().default(10),
  sort: z.enum(['createdAt', 'name', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().max(100).optional()
});
```

**Key conventions:**
- Query params use `.transform(val => parseInt(val))` to convert string → number (HTTP query strings are always strings)
- Create schemas use `.trim()` and `.regex()` for input cleaning
- Update schemas use `.partial()` on the create schema
- Type inference: `type Input = z.infer<typeof schema>` when needed

---

## 8. Error Classes (src/errors/)

### Error Pattern

```typescript
// src/errors/project.errors.ts
export class CategoryError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'CATEGORY_ERROR') {
    super(message);
    this.name = 'CategoryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class CategoryNotFoundError extends CategoryError {
  constructor(message: string = 'Category not found') {
    super(message, 404, 'CATEGORY_NOT_FOUND');
  }
}

export class CategoryAlreadyExistsError extends CategoryError {
  constructor(message: string = 'Category with this name already exists') {
    super(message, 400, 'CATEGORY_ALREADY_EXISTS');
  }
}

export class CategoryValidationError extends CategoryError {
  constructor(message: string = 'Invalid category data') {
    super(message, 400, 'CATEGORY_VALIDATION_ERROR');
  }
}
```

### Standard Error Classes per Domain

| Error Class | Status | Code |
|-------------|--------|------|
| `DomainNotFoundError` | 404 | `DOMAIN_NOT_FOUND` |
| `DomainAlreadyExistsError` | 400/409 | `DOMAIN_ALREADY_EXISTS` |
| `DomainValidationError` | 400 | `DOMAIN_VALIDATION_ERROR` |

---

## 9. Middleware Chain (src/middleware/)

### Rate Limiting

```typescript
// src/middleware/apiRateLimiter.ts
export const marketRateLimiter = async (req, res, next) => {
  // 3 concurrent Redis-based windows:
  //   BURST: 20 req/second
  //   MINUTE: 1,200 req/minute
  //   HOUR: 72,000 req/hour
  // Returns 429 if any exceeded
  // Graceful: allows request if Redis fails
};
```

### Authentication

```typescript
// src/middleware/authMiddleware.ts
export const validatePrivyToken = (req, res, next) => {
  // 1. Extract Bearer token from Authorization header
  // 2. Verify with AuthService (Privy)
  // 3. Set req.user = { sub: privyUserId, ... }
  // 4. Returns 401 on failure
};
```

### Role Authorization

```typescript
// src/middleware/roleMiddleware.ts
export const requireRole = (allowedRoles: UserRole[]) => async (req, res, next) => {
  // 1. Read req.user.sub (privyUserId)
  // 2. Query prisma.user for role
  // 3. Check role ∈ allowedRoles
  // 4. Set req.currentUser = { id, role, privyUserId }
  // 5. Returns 403 if insufficient
};

export const requireUser = requireRole([UserRole.USER, UserRole.MODERATOR, UserRole.ADMIN]);
export const requireModerator = requireRole([UserRole.MODERATOR, UserRole.ADMIN]);
export const requireAdmin = requireRole([UserRole.ADMIN]);
```

### Validation

```typescript
// src/middleware/validation/validation.middleware.ts
export const validateRequest = (schema: ZodObject<any>) => async (req, res, next) => {
  // Validates { body: req.body, query: req.query, params: req.params }
  // Returns 400 with error details on failure
  // Optional Redis cache for repeated validations
};
```

### Domain-Specific Validation

```typescript
// src/middleware/validation/wallet.validation.ts
export const validateCreateWallet = (req, res, next) => {
  walletCreateSchema.parse(req.body);
  next();
};
```

---

## 10. Route Layer (src/routes/)

### Standard Route Pattern

```typescript
// src/routes/project/category.routes.ts
const router = Router();
const categoryService = new CategoryService();

router.use(marketRateLimiter);

// GET — public, no auth
router.get('/', async (req, res) => {
  try {
    const categories = await categoryService.getAll(req.query);
    res.json({ success: true, data: categories.data, pagination: categories.pagination });
  } catch (error) {
    if (error instanceof CategoryError) {
      return res.status(error.statusCode).json({
        success: false, error: error.message, code: error.code
      });
    }
    res.status(500).json({
      success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

// POST — auth + role required
router.post('/', validatePrivyToken, requireModerator, async (req, res) => {
  try {
    const category = await categoryService.create(req.body);
    res.status(201).json({ success: true, message: 'Category created successfully', data: category });
  } catch (error) {
    // ... error mapping
  }
});

// DELETE — admin only
router.delete('/:id', validatePrivyToken, requireAdmin, async (req, res) => {
  // ...
});
```

### Response Format

```typescript
// Success
{ success: true, data: T, message?: string, pagination?: BasePagination }

// Error
{ success: false, error: string, code: string }
```

### Route Registration (app.ts)

```typescript
app.use('/project', projectRoutes);
app.use('/project/csv', projectCsvRoutes);
app.use('/category', categoryRoutes);
app.use('/wallet', walletRoutes);
app.use('/liquidations', liquidationsRoutes);
// ...
```

---

## 11. Putting It All Together — Concrete Example

### POST /category (Create a category)

```
1. REQUEST: POST /category { name: "DeFi", description: "Decentralized Finance" }

2. MIDDLEWARE CHAIN:
   marketRateLimiter     → checks Redis rate limits (burst/minute/hour)
   validatePrivyToken    → extracts JWT → req.user.sub = "privy:abc123"
   requireModerator      → DB lookup → user.role = MODERATOR → OK

3. ROUTE HANDLER (category.routes.ts):
   categoryService.create(req.body)

4. BASE SERVICE (crudBase.service.ts):
   a. validateInput(data, categoryCreateSchema) → Zod validates name/description
   b. transactionService.execute(async (tx) => {
        repository.setPrismaClient(tx);
        exists = await repository.existsByName("DeFi");  → false
        return repository.create({ name: "DeFi", description: "..." });
      })
   c. repository.resetPrismaClient();
   d. cacheService.getOrSet("category:42", ..., 300);   → cache new entity
   e. cacheService.invalidateByPattern("category*");     → clear list caches

5. REPOSITORY (prisma.category.repository.ts):
   executeWithErrorHandling(
     async () => tx.category.create({ data: { name: "DeFi", description: "..." } }),
     'creating category',
     { name: "DeFi" }
   )

6. PRISMA → PostgreSQL:
   INSERT INTO "Category" (name, description, "createdAt", "updatedAt")
   VALUES ('DeFi', 'Decentralized Finance', NOW(), NOW())
   RETURNING *;

7. RESPONSE:
   {
     "success": true,
     "message": "Category created successfully",
     "data": { "id": 42, "name": "DeFi", "description": "Decentralized Finance", ... }
   }
```

---

## 12. Adding a New Domain — Checklist

### Step 1: Types
```
src/types/domain.types.ts
  → DomainResponse, DomainCreateInput, DomainUpdateInput, DomainQueryParams
```

### Step 2: Zod Schemas
```
src/schemas/domain.schema.ts
  → domainCreateSchema, domainUpdateSchema, domainQuerySchema
```

### Step 3: Error Classes
```
src/errors/domain.errors.ts
  → DomainError, DomainNotFoundError, DomainAlreadyExistsError, DomainValidationError
```

### Step 4: Repository Interface
```
src/repositories/interfaces/domain.repository.interface.ts
  → interface DomainRepository extends BaseRepository { findAll, findById, create, update, delete, ... }
```

### Step 5: Repository Implementation
```
src/repositories/prisma/prisma.domain.repository.ts
  → class PrismaDomainRepository extends BasePrismaRepository implements DomainRepository
```

### Step 6: Export Instance
```
src/repositories/index.ts
  → export const domainRepository: DomainRepository = new PrismaDomainRepository();
```

### Step 7: Service
```
src/services/domain/domain.service.ts
  → class DomainService extends BaseService<Response, CreateInput, UpdateInput, QueryParams>
  → Implement: checkExists, checkExistsForUpdate, checkCanDelete
  → Add custom domain methods
```

### Step 8: Cache Prefix
```
src/constants/cache.constants.ts
  → CACHE_PREFIX.DOMAIN = 'domain'
  → CACHE_KEYS.DOMAIN = (id) => ...
```

### Step 9: Routes
```
src/routes/domain/domain.routes.ts
  → Router with marketRateLimiter, auth, validation, error handling
```

### Step 10: Register in app.ts
```
app.use('/domain', domainRoutes);
```

---

## Key Patterns Summary

| Pattern | Location | Purpose |
|---------|----------|---------|
| **Singleton** | All services & repositories | Single instance, shared state |
| **Repository** | `src/repositories/` | Abstract DB access behind interfaces |
| **BaseService** | `src/core/crudBase.service.ts` | DRY CRUD with validation, cache, transactions |
| **Transaction** | `src/core/transaction.service.ts` | Atomic multi-step operations |
| **Cache-Aside** | `src/core/cache.service.ts` | Redis check → DB fallback → populate cache |
| **Error Hierarchy** | `src/errors/` | Domain errors with statusCode + code |
| **Zod Validation** | `src/schemas/` | Runtime validation at middleware + service level |
| **Middleware Chain** | `src/middleware/` | Rate limit → Auth → Role → Validation → Handler |
