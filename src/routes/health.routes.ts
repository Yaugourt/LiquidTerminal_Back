import { Router } from 'express';
import { prisma } from '../core/prisma.service';
import { redisService } from '../core/redis.service';
import { ClientInitializerService } from '../core/client.initializer.service';

const router = Router();
const clientInitializer = ClientInitializerService.getInstance();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  startup: {
    status: 'booting' | 'ready' | 'degraded';
  };
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

interface DependencyChecks {
  database: HealthStatus['checks']['database'];
  redis: HealthStatus['checks']['redis'];
}

async function getDependencyChecks(): Promise<DependencyChecks> {
  const checks: DependencyChecks = {
    database: { status: 'down' },
    redis: { status: 'down' },
  };

  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'up', latencyMs: Date.now() - dbStart };
  } catch (error) {
    checks.database = {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    const redisStart = Date.now();
    const redis = redisService.getClient();
    await redis.ping();
    checks.redis = { status: 'up', latencyMs: Date.now() - redisStart };
  } catch (error) {
    checks.redis = {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  return checks;
}

function computeOverallStatus(checks: DependencyChecks): HealthStatus['status'] {
  const dbDown = checks.database.status === 'down';
  const redisDown = checks.redis.status === 'down';

  if (dbDown && redisDown) {
    return 'unhealthy';
  }

  if (dbDown || redisDown) {
    return 'degraded';
  }

  return 'healthy';
}

router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

router.get('/ready', async (_req, res) => {
  const checks = await getDependencyChecks();
  const startupStatus = clientInitializer.getStartupStatus();
  const dependenciesHealthy = checks.database.status === 'up' && checks.redis.status === 'up';
  const isReady = startupStatus === 'ready' && dependenciesHealthy;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'healthy' : startupStatus === 'booting' ? 'degraded' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    startup: {
      status: startupStatus,
    },
    checks,
  });
});

router.get('/', async (_req, res) => {
  const checks = await getDependencyChecks();
  const startupStatus = clientInitializer.getStartupStatus();
  const health: HealthStatus = {
    status: computeOverallStatus(checks),
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    startup: {
      status: startupStatus,
    },
    checks,
    memory: formatMemory(),
  };

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
