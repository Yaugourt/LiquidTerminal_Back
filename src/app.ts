import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { logDeduplicator } from './utils/logDeduplicator';
import 'dotenv/config';
import { createServer } from 'http';
import { sanitizeInput } from './middleware/validation';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import { SECURITY_CONSTANTS } from './constants/security.constants';
import { securityHeaders } from './middleware/security.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

import { ClientInitializerService } from './core/client.initializer.service';
import { prisma } from './core/prisma.service';
import { PrismaHistoricalService } from './core/prisma.historical.service';
// Eagerly instantiate Content/Telegram Prisma singletons so connection errors
// surface at boot rather than at the first request.
import { PrismaContentService } from './core/prisma.content.service';
import { PrismaTelegramService } from './core/prisma.telegram.service';
import { FileCleanupService } from './utils/fileCleanup';
import { InternalWebSocketServer } from './websocket';
import { redisService } from './core/redis.service';
import { flushLogs } from './utils/logger';

import authRoutes from './routes/auth/auth.routes';
import userAuthRoutes from './routes/auth/user.auth.routes';

import marketSpotRoutes from './routes/spot/marketSpot.routes';
import marketPerpRoutes from './routes/perp/marketPerp.routes';
import globalSpotStatsRoutes from './routes/spot/spotStats.routes';
import stablecoinsRoutes from './routes/spot/stablecoins.routes';
import globalPerpStatsRoutes from './routes/perp/perpStats.routes';
import auctionRoutes from './routes/spot/auction.routes';
import vaultsRoutes from './routes/vault/vaults.routes';
import feesRoutes from './routes/fees/fees.routes';

import walletRoutes from './routes/wallet/wallet.routes';
import projectRoutes from './routes/project/project.routes';
import categoryRoutes from './routes/project/category.routes';
import projectCsvRoutes from './routes/project/csv-upload.routes';
import educationalRoutes from './routes/educational';
import readListRoutes from './routes/readlist';
import walletListRoutes from './routes/walletlist';
import linkPreviewRoutes from './routes/linkPreview/linkPreview.routes';
import publicGoodRoutes from './routes/publicgood';

import validatorRoutes from './routes/staking/validator.routes';
import trendingValidatorRoutes from './routes/staking/trendingValidator.routes';
import validationRoutes from './routes/staking/validation.routes';
import unstakingRoutes from './routes/staking/unstaking.routes';
import stakedHoldersRoutes from './routes/staking/stakedHolders.routes';
import dashboardGlobalStatsRoutes from './routes/globalStats.routes';
import leaderboardRoutes from './routes/leaderboard/leaderboard.routes';
import xpRoutes from './routes/xp/xp.routes';

import telegramRoutes from './routes/telegram';

import healthRoutes from './routes/health.routes';
import liquidationsRoutes from './routes/liquidations/liquidations.routes';
import topTradersRoutes from './routes/toptraders/toptraders.routes';
import activeUsersRoutes from './routes/activeusers/activeusers.routes';
import buildersRoutes from './routes/builders/builders.routes';
import indexerRoutes from './routes/indexer';

const app = express();
const server = createServer(app);
let isShuttingDown = false;
let forceExitTimer: NodeJS.Timeout | null = null;

// Désactiver l'en-tête X-Powered-By pour des raisons de sécurité
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Compression gzip des réponses (réduit la bande passante de 60-80%)
app.use(compression());

// Ajouter Request ID pour traçabilité (doit être en premier)
app.use(requestIdMiddleware);

// Configuration CORS basée sur les constantes de sécurité
app.use(cors({
  origin: (origin, callback) => {
    // Always validate against allowed origins (defense in depth)
    // In development, localhost origins are included via SECURITY_CONSTANTS defaults
    if (!origin || SECURITY_CONSTANTS.ALLOWED_ORIGINS.includes(origin as typeof SECURITY_CONSTANTS.ALLOWED_ORIGINS[number])) {
      callback(null, true);
    } else {
      logDeduplicator.warn('CORS blocked origin', {
        origin,
        nodeEnv: process.env.NODE_ENV
      });
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  credentials: true
}));

// Ajouter les en-têtes de sécurité
app.use(securityHeaders);

// Parser le body avant la sanitization
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Appliquer la sanitization globalement
app.use(sanitizeInput);

// Note: File uploads now use Cloudflare R2 directly (no local /uploads folder)
// Legacy /uploads endpoints removed as all images are stored in R2

// Routes Pages
app.use('/auth', authRoutes);
app.use('/user', userAuthRoutes);
app.use('/market/spot', marketSpotRoutes);
app.use('/market/perp', marketPerpRoutes);
app.use('/market/auction', auctionRoutes);
app.use('/market/vaults', vaultsRoutes);
app.use('/market/fees', feesRoutes);
app.use('/wallet', walletRoutes);
app.use('/project', projectRoutes);
app.use('/project/csv', projectCsvRoutes);
app.use('/category', categoryRoutes);
app.use('/educational', educationalRoutes);
app.use('/readlists', readListRoutes);
app.use('/walletlists', walletListRoutes);
app.use('/link-preview', linkPreviewRoutes);
app.use('/publicgoods', publicGoodRoutes);
app.use('/staking/validators', validatorRoutes);
app.use('/staking/validators/trending', trendingValidatorRoutes);
app.use('/staking/validations', validationRoutes);
app.use('/staking/unstaking-queue', unstakingRoutes);
app.use('/staking/holders', stakedHoldersRoutes);
app.use('/home/globalstats', dashboardGlobalStatsRoutes);
app.use('/market/spot/globalstats', globalSpotStatsRoutes);
app.use('/market/stablecoins', stablecoinsRoutes);
app.use('/market/perp/globalstats', globalPerpStatsRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/xp', xpRoutes);
app.use('/telegram', telegramRoutes);
app.use('/api/health', healthRoutes);
app.use('/liquidations', liquidationsRoutes);
app.use('/top-traders', topTradersRoutes);
app.use('/active-users', activeUsersRoutes);
app.use('/builders', buildersRoutes);
app.use('/indexer', indexerRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3002;

const clientInitializer = ClientInitializerService.getInstance();
const wsServer = InternalWebSocketServer.getInstance();
wsServer.initialize(server);
void logDeduplicator.info('WebSocket Server initialized on /ws');

async function bootstrapApplication(): Promise<void> {
  try {
    await logDeduplicator.info('Starting asynchronous application bootstrap...');
    await clientInitializer.initialize();

    const fileCleanupService = FileCleanupService.getInstance();
    fileCleanupService.startAutoCleanup();

    await logDeduplicator.info('Application bootstrap completed successfully');
  } catch (error) {
    await logDeduplicator.error('Failed to initialize clients:', { error: error instanceof Error ? error.message : String(error) });
    await gracefulShutdown('BOOT_FAILURE', 1);
  }
}

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  await logDeduplicator.info(`Received ${signal}. Performing graceful shutdown...`);

  // 1. Stop accepting new connections
  server.close(async () => {
    await logDeduplicator.info('HTTP server closed');
  });

  try {
    // 2. Shutdown WebSocket Server
    InternalWebSocketServer.getInstance().shutdown();

    // 3. Stop all polling, flush ingestion buffer, shutdown SSE connections
    await clientInitializer.stopAllPolling();

    // 4. Disconnect databases
    await prisma.$disconnect();
    await PrismaHistoricalService.disconnect();
    await PrismaContentService.disconnect();
    await PrismaTelegramService.disconnect();

    // 5. Disconnect Redis
    await redisService.disconnect();

    await logDeduplicator.info('Graceful shutdown complete');
  } catch (error) {
    await logDeduplicator.error('Graceful shutdown failed', {
      signal,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    exitCode = 1;
  } finally {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    await flushLogs();
    process.exit(exitCode);
  }
}

// Force exit after 30s if graceful shutdown hangs
function forceExit(signal: string): void {
  if (forceExitTimer) {
    return;
  }

  forceExitTimer = setTimeout(() => {
    void logDeduplicator.error(`Forced exit after ${signal} - shutdown took too long`);
    process.exit(1);
  }, 30000).unref();
}

server.on('error', (error) => {
  void logDeduplicator.error('HTTP server error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});

server.listen(PORT, () => {
  void logDeduplicator.info(`Server is running on port ${PORT}`);
  void logDeduplicator.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  void bootstrapApplication();
});

process.on('SIGINT', () => {
  forceExit('SIGINT');
  void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  forceExit('SIGTERM');
  void gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  void logDeduplicator.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  forceExit('UNHANDLED_REJECTION');
  void gracefulShutdown('UNHANDLED_REJECTION', 1);
});

process.on('uncaughtException', (error) => {
  void logDeduplicator.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  forceExit('UNCAUGHT_EXCEPTION');
  void gracefulShutdown('UNCAUGHT_EXCEPTION', 1);
});

export default app;