import express from 'express';
import cors from 'cors';
import { logDeduplicator } from './utils/logDeduplicator';
import 'dotenv/config';
import { createServer } from 'http';
import { sanitizeInput } from './middleware/validation';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import { SECURITY_CONSTANTS } from './constants/security.constants';
import { securityHeaders } from './middleware/security.middleware';

import { ClientInitializerService } from './core/client.initializer.service';
import { prisma } from './core/prisma.service';
import { FileCleanupService } from './utils/fileCleanup';

import authRoutes from './routes/auth/auth.routes';
import userAuthRoutes from './routes/auth/user.auth.routes';

import marketSpotRoutes from './routes/spot/marketSpot.routes';
import marketPerpRoutes from './routes/perp/marketPerp.routes';
import globalSpotStatsRoutes from './routes/spot/spotStats.routes';
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

import healthRoutes from './routes/health.routes';

const app = express();
const server = createServer(app);

// Désactiver l'en-tête X-Powered-By pour des raisons de sécurité
app.disable('x-powered-by');

// Ajouter Request ID pour traçabilité (doit être en premier)
app.use(requestIdMiddleware);

// Configuration CORS basée sur les constantes de sécurité
app.use(cors({
  origin: (origin, callback) => {
    // ✅ CORS Strategy:
    // - DEV: Permissive (facilitates local development, tunnels, mobile testing)
    // - PROD: Whitelist only (SECURITY_CONSTANTS.ALLOWED_ORIGINS)
    // This is intentional and follows industry best practices
    if (process.env.NODE_ENV === 'development') {
      callback(null, true);
    }
    // En production, vérifier contre les origines autorisées
    else if (!origin || SECURITY_CONSTANTS.ALLOWED_ORIGINS.includes(origin as typeof SECURITY_CONSTANTS.ALLOWED_ORIGINS[number])) {
      callback(null, true);
    } else {
      logDeduplicator.warn('CORS blocked origin', {
        origin,
        allowedOrigins: SECURITY_CONSTANTS.ALLOWED_ORIGINS,
        nodeEnv: process.env.NODE_ENV
      });
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
app.use('/market/perp/globalstats', globalPerpStatsRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/xp', xpRoutes);
app.use('/api/health', healthRoutes);

const PORT = process.env.PORT || 3002;

// Initialiser les clients avant de démarrer le serveur
const clientInitializer = ClientInitializerService.getInstance();

// ✅ Attendre l'initialisation avant de démarrer le serveur
clientInitializer.initialize()
  .then(() => {
    logDeduplicator.info('All clients initialized, starting server...');

    // Démarrer le service de nettoyage automatique des fichiers
    const fileCleanupService = FileCleanupService.getInstance();
    fileCleanupService.startAutoCleanup();

    server.listen(PORT, () => {
      logDeduplicator.info(`Server is running on port ${PORT}`);
    });
  })
  .catch((error) => {
    logDeduplicator.error('Failed to initialize clients:', { error });
    process.exit(1); // Arrêter l'app si l'initialisation échoue
  });

// Gestion de l'arrêt propre de l'application
process.on('SIGINT', async () => {
  logDeduplicator.info('Received SIGINT. Performing graceful shutdown...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logDeduplicator.info('Received SIGTERM. Performing graceful shutdown...');
  await prisma.$disconnect();
  process.exit(0);
});

export default app;