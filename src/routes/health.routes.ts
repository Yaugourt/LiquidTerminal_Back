import { Router } from 'express';
import { prisma } from '../core/prisma.service';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: {
    database: { status: 'up' | 'down'; latencyMs?: number; error?: string };
    redis: { status: 'up' | 'down'; latencyMs?: number; error?: string };
  };
  memory: {
    rss: string;
    heapUsed: string;
    heapTotal: string;
    external: string;
  };
}

router.get('/', async (req, res) => {
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: { status: 'down' },
      redis: { status: 'down' },
    },
    memory: formatMemory(),
  };

  // Check database
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    health.checks.database = { status: 'up', latencyMs: Date.now() - dbStart };
  } catch (error) {
    health.checks.database = {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    const redis = redisService.getClient();
    await redis.ping();
    health.checks.redis = { status: 'up', latencyMs: Date.now() - redisStart };
  } catch (error) {
    health.checks.redis = {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Determine overall status
  const dbDown = health.checks.database.status === 'down';
  const redisDown = health.checks.redis.status === 'down';

  if (dbDown && redisDown) {
    health.status = 'unhealthy';
  } else if (dbDown || redisDown) {
    health.status = 'degraded';
  }

  const httpStatus = health.status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json(health);
});

function formatMemory(): HealthStatus['memory'] {
  const mem = process.memoryUsage();
  const toMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return {
    rss: toMB(mem.rss),
    heapUsed: toMB(mem.heapUsed),
    heapTotal: toMB(mem.heapTotal),
    external: toMB(mem.external),
  };
}

export default router;
