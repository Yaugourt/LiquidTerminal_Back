import { HyperliquidSpotClient } from '../clients/hyperliquid/spot/spot.assetcontext.client';
import { HyperliquidPerpClient } from '../clients/hyperliquid/perp/perp.assetcontext.client';
import { HyperliquidSpotDeployClient } from '../clients/hyperliquid/spot/spot.deploy.client';
import { HyperliquidTokenInfoClient } from '../clients/hyperliquid/spot/spot.tokeninfo.client';
import { ValidatorClient } from '../clients/hyperliquid/staking/validator';
import { HyperliquidVaultClient } from '../clients/hyperliquid/vault/hlpvault.client';
import { HyperliquidVaultsClient } from '../clients/hyperliquid/vault/vaults.client';
import { HypurrscanClient } from '../clients/hypurrscan/auction.client';
import { HypurrscanValidationClient } from '../clients/hypurrscan/validation.client';
import { HypurrscanUnstakingClient } from '../clients/hypurrscan/unstaking.client';
import { SpotUSDCClient } from '../clients/hypurrscan/spotUSDC.client';
import { HyperliquidSpotStatsClient } from '../clients/hyperliquid/spot/spot.stats.client';
import { HypurrscanFeesClient } from '../clients/hypurrscan/fees.client';
import { HyperliquidGlobalStatsClient } from '../clients/hyperliquid/globalstats.client';
import { HyperliquidLeaderboardClient } from '../clients/hyperliquid/leaderboard/leaderboard.client';
import { HypurrscanStakedHoldersClient } from '../clients/hypurrscan/stakedHolders.client';
import { HLIndexerLiquidationsClient } from '../clients/hlindexer/liquidations/liquidations.client';
import { SSEManagerService } from '../services/liquidations/sse-manager.service';
import { LiquidationsWebSocketService } from '../services/liquidations/liquidations.ws.service';
import { HLIndexerTopTradersClient } from '../clients/hlindexer/toptraders/toptraders.client';
import { HLIndexerActiveUsersClient } from '../clients/hlindexer/activeusers/activeusers.client';
import { LiquidationsIngestionService } from '../services/liquidations/liquidations.ingestion.service';
import { LiquidationsBackfillService } from '../services/liquidations/liquidations.backfill.service';
import { TelegramWalletDispatcherService } from '../services/telegram/telegram.wallet-dispatcher.service';
import { TelegramLiquidationDispatcherService } from '../services/telegram/telegram.liquidation-dispatcher.service';
import { logDeduplicator } from '../utils/logDeduplicator';

export type StartupStatus = 'booting' | 'ready' | 'degraded';

export class ClientInitializerService {
  private static instance: ClientInitializerService;
  private clients: Map<string, any> = new Map();
  private startupStatus: StartupStatus = 'booting';
  private dailyBackfillTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): ClientInitializerService {
    if (!ClientInitializerService.instance) {
      ClientInitializerService.instance = new ClientInitializerService();
    }
    return ClientInitializerService.instance;
  }

  public async initializeAll(): Promise<void> {
    try {
      await Promise.all([
        this.initializeMarketData(),
        this.initializeSpotStats(),
        this.initializePerpStats(),
        this.initializeGlobalStatsLiquid()
      ]);
      logDeduplicator.info('All clients initialized successfully');
    } catch (error) {
      logDeduplicator.error('Error initializing clients:', { error });
      throw error;
    }
  }

  private async initializeMarketData(): Promise<void> {
    // Implementation of initializeMarketData
  }

  private async initializeSpotStats(): Promise<void> {
    // Implementation of initializeSpotStats
  }

  private async initializePerpStats(): Promise<void> {
    // Implementation of initializePerpStats
  }

  private async initializeGlobalStatsLiquid(): Promise<void> {
    // Implementation of initializeGlobalStatsLiquid
  }

  public async initialize(): Promise<void> {
    try {
      this.startupStatus = 'booting';
      logDeduplicator.info('Starting client initialization...');

      // ✅ Redis est déjà prêt, on peut initialiser les clients directement
      logDeduplicator.info('Redis is ready, initializing clients...');

      // Initialiser le client Spot
      logDeduplicator.info('Initializing Spot client...');
      const spotClient = HyperliquidSpotClient.getInstance();
      this.clients.set('spot', spotClient);
      logDeduplicator.info('Spot client initialized successfully');

      // Initialiser le client Perp
      logDeduplicator.info('Initializing Perp client...');
      const perpClient = HyperliquidPerpClient.getInstance();
      this.clients.set('perp', perpClient);
      logDeduplicator.info('Perp client initialized successfully');

      // Initialiser le client Spot Deploy
      const spotDeployClient = HyperliquidSpotDeployClient.getInstance();
      this.clients.set('spotDeploy', spotDeployClient);

      // Initialiser le client Token Info
      const tokenInfoClient = HyperliquidTokenInfoClient.getInstance();
      this.clients.set('tokenInfo', tokenInfoClient);

      // Initialiser le client Validator
      const validatorClient = ValidatorClient.getInstance();
      this.clients.set('validator', validatorClient);

      // Initialiser le client Vault
      const vaultClient = HyperliquidVaultClient.getInstance();
      this.clients.set('vault', vaultClient);

      // Initialiser le client Vaults (liste des vaults)
      const vaultsClient = HyperliquidVaultsClient.getInstance();
      this.clients.set('vaults', vaultsClient);

      // Initialiser le client Spot Stats
      const spotStatsClient = HyperliquidSpotStatsClient.getInstance();
      this.clients.set('spotStats', spotStatsClient);

      // Initialiser les clients Hypurrscan
      const hypurrscanClient = HypurrscanClient.getInstance();
      this.clients.set('hypurrscanAuction', hypurrscanClient);

      const hypurrscanValidationClient = HypurrscanValidationClient.getInstance();
      this.clients.set('hypurrscanValidation', hypurrscanValidationClient);

      const hypurrscanUnstakingClient = HypurrscanUnstakingClient.getInstance();
      this.clients.set('hypurrscanUnstaking', hypurrscanUnstakingClient);

      const spotUSDCClient = SpotUSDCClient.getInstance();
      this.clients.set('spotUSDC', spotUSDCClient);

      // Initialiser le client Fees
      const feesClient = HypurrscanFeesClient.getInstance();
      this.clients.set('fees', feesClient);

      // Initialiser le client Global Stats
      const globalStatsClient = HyperliquidGlobalStatsClient.getInstance();
      this.clients.set('globalStats', globalStatsClient);

      // Initialiser le client Leaderboard
      const leaderboardClient = HyperliquidLeaderboardClient.getInstance();
      this.clients.set('leaderboard', leaderboardClient);

      // Initialiser le client Staked Holders
      const stakedHoldersClient = HypurrscanStakedHoldersClient.getInstance();
      this.clients.set('stakedHolders', stakedHoldersClient);

      // Initialiser le client Liquidations HLIndexer (polling disabled - data from historical DB)
      const liquidationsClient = HLIndexerLiquidationsClient.getInstance();
      this.clients.set('liquidations', liquidationsClient);

      // Initialiser le SSE Manager pour les liquidations temps réel (legacy, keep for backward compatibility)
      const sseManager = SSEManagerService.getInstance();
      await sseManager.initialize();
      this.clients.set('sseManager', sseManager);
      logDeduplicator.info('SSE Manager initialized successfully');

      // Initialiser le WebSocket Service pour les liquidations temps réel (new)
      const liquidationsWSService = LiquidationsWebSocketService.getInstance();
      this.clients.set('liquidationsWS', liquidationsWSService);
      logDeduplicator.info('Liquidations WebSocket Service initialized successfully');

      // Initialiser le client Top Traders (background polling + cache handled by client)
      const topTradersClient = HLIndexerTopTradersClient.getInstance();
      this.clients.set('topTraders', topTradersClient);
      logDeduplicator.info('Top Traders client initialized successfully');

      // Initialiser le client Active Users (background polling every 60s - client owns cache)
      const activeUsersClient = HLIndexerActiveUsersClient.getInstance();
      this.clients.set('activeUsers', activeUsersClient);
      logDeduplicator.info('Active Users client initialized successfully');

      // Initialiser le service d'ingestion des liquidations (WebSocket → DB historique)
      const ingestionService = LiquidationsIngestionService.getInstance();
      this.clients.set('liquidationsIngestion', ingestionService);
      logDeduplicator.info('Liquidations Ingestion service initialized successfully');

      // Initialiser le service de backfill des liquidations (REST → DB historique)
      const backfillService = LiquidationsBackfillService.getInstance();
      this.clients.set('liquidationsBackfill', backfillService);
      logDeduplicator.info('Liquidations Backfill service initialized successfully');

      // Initialiser le dispatcher wallet events pour le bot Telegram
      const walletDispatcher = TelegramWalletDispatcherService.getInstance();
      this.clients.set('walletDispatcher', walletDispatcher);
      logDeduplicator.info('Telegram Wallet Dispatcher service initialized successfully');

      // Initialiser le dispatcher liquidations pour le bot Telegram
      const liquidationDispatcher = TelegramLiquidationDispatcherService.getInstance();
      this.clients.set('liquidationDispatcher', liquidationDispatcher);
      logDeduplicator.info('Telegram Liquidation Dispatcher service initialized successfully');

      // Démarrer le polling pour tous les clients
      logDeduplicator.info('All clients created, starting polling...');
      await this.startAllPolling();
      this.startupStatus = 'ready';

      logDeduplicator.info('All clients initialized successfully');
    } catch (error) {
      this.startupStatus = 'degraded';
      logDeduplicator.error('Error initializing clients:', { error });
      throw error;
    }
  }

  public getStartupStatus(): StartupStatus {
    return this.startupStatus;
  }

  private async startAllPolling(): Promise<void> {
    logDeduplicator.info('Starting polling for all clients...');

    // 1. Start all standard polling clients
    for (const [name, client] of this.clients.entries()) {
      if ('startPolling' in client) {
        try {
          client.startPolling();
          logDeduplicator.info(`Started polling for ${name} client`);
        } catch (error) {
          logDeduplicator.error(`Error starting polling for ${name} client:`, { error });
        }
      }
    }

    // 2. Start Liquidations WebSocket (connects and starts receiving data)
    const wsClient = this.clients.get('liquidationsWS');
    if (wsClient) {
      try {
        wsClient.start();
        logDeduplicator.info('Started Liquidations WebSocket Service');
      } catch (error) {
        logDeduplicator.error('Error starting Liquidations WebSocket Service:', { error });
      }
    }

    // 3. Start Ingestion Service (subscribes to WS, buffers + flushes to DB)
    const ingestionClient = this.clients.get('liquidationsIngestion');
    if (ingestionClient) {
      try {
        ingestionClient.start();
        logDeduplicator.info('Started Liquidations Ingestion Service');
      } catch (error) {
        logDeduplicator.error('Error starting Liquidations Ingestion Service:', { error });
      }
    }

    // 4. Run Backfill at startup + schedule daily at 03:00 UTC to fill gaps
    const backfillClient = this.clients.get('liquidationsBackfill');
    if (backfillClient) {
      void backfillClient.start()
        .then(() => {
          logDeduplicator.info('Liquidations Backfill completed (startup)');
        })
        .catch((error: unknown) => {
          logDeduplicator.error('Error during Liquidations Backfill (startup):', { error });
        });

      logDeduplicator.info('Started Liquidations Backfill Service in background');
      this.scheduleDailyBackfill(backfillClient);
    }

    // 5. Start Telegram Wallet Dispatcher (connects to HypeDexer completed_trades)
    const walletDispatcher = this.clients.get('walletDispatcher');
    if (walletDispatcher) {
      try {
        walletDispatcher.start();
        logDeduplicator.info('Started Telegram Wallet Dispatcher Service');
      } catch (error) {
        logDeduplicator.error('Error starting Telegram Wallet Dispatcher Service:', { error });
      }
    }

    // 6. Start Telegram Liquidation Dispatcher (subscribes to LiquidationsWebSocketService)
    const liquidationDispatcher = this.clients.get('liquidationDispatcher');
    if (liquidationDispatcher) {
      try {
        liquidationDispatcher.start();
        logDeduplicator.info('Started Telegram Liquidation Dispatcher Service');
      } catch (error) {
        logDeduplicator.error('Error starting Telegram Liquidation Dispatcher Service:', { error });
      }
    }

    logDeduplicator.info('All client polling started successfully');
  }

  private scheduleDailyBackfill(backfillClient: { start: () => Promise<void> }): void {
    const scheduleNext = (): void => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(3, 0, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      const delay = next.getTime() - now.getTime();

      logDeduplicator.info('Daily backfill scheduled', {
        nextRun: next.toISOString(),
        delayMs: delay,
      });

      this.dailyBackfillTimer = setTimeout(() => {
        logDeduplicator.info('Starting daily backfill');
        void backfillClient.start()
          .then(() => { logDeduplicator.info('Daily backfill completed'); })
          .catch((error: unknown) => { logDeduplicator.error('Daily backfill error:', { error }); })
          .finally(() => { scheduleNext(); });
      }, delay);
    };

    scheduleNext();
  }

  public async stopAllPolling(): Promise<void> {
    // Stop daily backfill timer
    if (this.dailyBackfillTimer) {
      clearTimeout(this.dailyBackfillTimer);
      this.dailyBackfillTimer = null;
    }

    // Stop liquidation dispatcher
    const liquidationDispatcher = this.clients.get('liquidationDispatcher');
    if (liquidationDispatcher) {
      try {
        liquidationDispatcher.stop();
        logDeduplicator.info('Telegram Liquidation Dispatcher Service stopped');
      } catch (error) {
        logDeduplicator.error('Error stopping Telegram Liquidation Dispatcher Service:', { error });
      }
    }

    // Stop wallet dispatcher
    const walletDispatcher = this.clients.get('walletDispatcher');
    if (walletDispatcher) {
      try {
        walletDispatcher.stop();
        logDeduplicator.info('Telegram Wallet Dispatcher Service stopped');
      } catch (error) {
        logDeduplicator.error('Error stopping Telegram Wallet Dispatcher Service:', { error });
      }
    }

    // Stop ingestion FIRST — flush remaining batch before disconnecting DB
    const ingestionClient = this.clients.get('liquidationsIngestion');
    if (ingestionClient) {
      try {
        await ingestionClient.stop();
        logDeduplicator.info('Liquidations Ingestion Service stopped (final flush complete)');
      } catch (error) {
        logDeduplicator.error('Error stopping Liquidations Ingestion Service:', { error });
      }
    }

    // Stop backfill (sets flag to halt on next page)
    const backfillClient = this.clients.get('liquidationsBackfill');
    if (backfillClient) {
      try {
        backfillClient.stop();
        logDeduplicator.info('Liquidations Backfill Service stopped');
      } catch (error) {
        logDeduplicator.error('Error stopping Liquidations Backfill Service:', { error });
      }
    }

    // Stop WS
    const wsClient = this.clients.get('liquidationsWS');
    if (wsClient) {
      try {
        wsClient.stop();
        logDeduplicator.info('Liquidations WebSocket Service stopped');
      } catch (error) {
        logDeduplicator.error('Error stopping Liquidations WebSocket Service:', { error });
      }
    }

    // Stop SSE Manager
    const sseClient = this.clients.get('sseManager');
    if (sseClient && 'shutdown' in sseClient) {
      try {
        sseClient.shutdown();
        logDeduplicator.info('SSE Manager shutdown successfully');
      } catch (error) {
        logDeduplicator.error('Error shutting down SSE Manager:', { error });
      }
    }

    // Stop all standard polling clients
    for (const [name, client] of this.clients.entries()) {
      if ('stopPolling' in client) {
        try {
          client.stopPolling();
          logDeduplicator.info(`Stopped polling for ${name} client`);
        } catch (error) {
          logDeduplicator.error(`Error stopping polling for ${name} client:`, { error });
        }
      }
    }
  }
}
