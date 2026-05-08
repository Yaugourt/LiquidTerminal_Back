import { Router } from 'express';
import { prisma } from '../core/prisma.service';
import { prismaContent } from '../core/prisma.content.service';
import { prismaTelegram } from '../core/prisma.telegram.service';
import { prismaHistorical } from '../core/prisma.historical.service';
import { redisService } from '../core/redis.service';
import { ClientInitializerService } from '../core/client.initializer.service';

const router = Router();
const clientInitializer = ClientInitializerService.getInstance();

type DbCheck = { status: 'up' | 'down'; latencyMs?: number; error?: string };

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  startup: {
    status: 'booting' | 'ready' | 'degraded';
  };
  checks: {
    database: DbCheck;
    contentDatabase: DbCheck;
    telegramDatabase: DbCheck;
    historicalDatabase: DbCheck;
    redis: DbCheck;
  };
  memory: {
    rss: string;
    heapUsed: string;
    heapTotal: string;
    external: string;
  };
}

interface DependencyChecks {
  database: DbCheck;
  contentDatabase: DbCheck;
  telegramDatabase: DbCheck;
  historicalDatabase: DbCheck;
  redis: DbCheck;
}

async function pingPrisma(client: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }): Promise<DbCheck> {
  try {
    const start = Date.now();
    await client.$queryRaw`SELECT 1`;
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function getDependencyChecks(): Promise<DependencyChecks> {
  const [database, contentDatabase, telegramDatabase, historicalDatabase] = await Promise.all([
    pingPrisma(prisma),
    pingPrisma(prismaContent),
    pingPrisma(prismaTelegram),
    pingPrisma(prismaHistorical),
  ]);

  let redis: DbCheck;
  try {
    const start = Date.now();
    await redisService.getClient().ping();
    redis = { status: 'up', latencyMs: Date.now() - start };
  } catch (error) {
    redis = {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  return { database, contentDatabase, telegramDatabase, historicalDatabase, redis };
}

function computeOverallStatus(checks: DependencyChecks): HealthStatus['status'] {
  const downCount = [
    checks.database,
    checks.contentDatabase,
    checks.telegramDatabase,
    checks.historicalDatabase,
    checks.redis,
  ].filter((c) => c.status === 'down').length;

  if (downCount === 0) return 'healthy';
  if (downCount >= 4) return 'unhealthy';
  return 'degraded';
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
  // /ready gates traffic on Core DB + Redis; Content/Telegram/Historical surface
  // in /health for granular observability but don't block readiness because
  // the app can serve large parts of its surface even if one of them is briefly down.
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
