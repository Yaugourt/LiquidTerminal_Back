/**
 * Readiness decision, kept dependency-free so it is unit-testable without the
 * Prisma/Redis module graph that health.routes.ts pulls in.
 *
 * Readiness gates on the critical datastore (Core DB) ONLY. Redis is a cache
 * with an in-memory fallback on every path (rate limiting, dedup, cache), so a
 * Redis outage must NOT fail readiness: the Docker/Railway healthcheck hits
 * /api/health/ready, and gating it on Redis turned a Redis disk problem into a
 * container restart loop while the app was serving fine. Redis still surfaces
 * in /health's overall status for observability.
 */
export type StartupStatus = 'booting' | 'ready' | 'degraded';

export interface ReadinessChecks {
  database: { status: 'up' | 'down' };
}

export function isReady(startupStatus: StartupStatus, checks: ReadinessChecks): boolean {
  return startupStatus === 'ready' && checks.database.status === 'up';
}
