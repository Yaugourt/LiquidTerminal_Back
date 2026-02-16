# Contributing to LiquidTerminal Backend

## Getting Started

1. Fork the repository
2. Clone your fork
3. Copy `.env.example` to `.env` and configure your environment
4. Install dependencies: `npm install`
5. Generate Prisma client: `npx prisma generate`
6. Run migrations: `npx prisma migrate dev`
7. Start development server: `npm run dev`

## Development Guidelines

### Code Style

- TypeScript strict mode
- Single quotes, 2-space indentation
- Use `logDeduplicator` for logging (never `console.log`)
- Follow existing patterns: Singleton services, Repository pattern, BaseService

### Architecture

```
src/
├── clients/       # External API clients (BaseApiService)
├── core/          # Core services (Redis, Prisma, Cache)
├── middleware/     # Express middleware (auth, rate limiting, validation)
├── repositories/  # Data access layer (Prisma)
├── routes/        # Express route handlers
├── services/      # Business logic (Singleton pattern)
├── types/         # TypeScript interfaces and types
├── schemas/       # Zod validation schemas
├── errors/        # Custom error classes
└── utils/         # Utility functions
```

### Commit Messages

Use conventional commits:
- `feat:` new feature
- `fix:` bug fix
- `refactor:` code refactoring
- `docs:` documentation
- `test:` adding tests
- `chore:` maintenance

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `npx tsc --noEmit` passes with 0 errors
4. Ensure `npm run build` succeeds
5. Open a PR with a clear description

## Reporting Issues

Use GitHub Issues for bug reports and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
