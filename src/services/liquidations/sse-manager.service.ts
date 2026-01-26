import { Response } from 'express';
import { randomUUID } from 'crypto';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {
  SSEClient,
  SSEClientFilters,
  SSELiquidationEvent,
  SSEBroadcastMessage,
  SSEConnectionStats
} from '../../types/sse.types';
import { Liquidation } from '../../types/liquidations.types';

/**
 * SSE Manager Service
 * Manages Server-Sent Events connections for real-time liquidation streaming
 *
 * Features:
 * - In-memory client tracking with Map
 * - Redis Pub/Sub for cross-instance communication
 * - Per-client filtering (coin, minAmountDollars)
 * - Heartbeat to keep connections alive
 * - Support for reconnection with Last-Event-ID
 */
export class SSEManagerService {
  private static instance: SSEManagerService;

  // Configuration
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;     // 30 seconds
  private static readonly MAX_CONNECTIONS_PER_IP = 3;          // Limit per IP
  private static readonly MAX_TOTAL_CONNECTIONS = 1000;        // Server limit
  private static readonly REDIS_CHANNEL = 'liquidations:sse:broadcast';
  private static readonly LAST_TID_KEY = 'liquidations:sse:lastTid';
  private static readonly MISSED_DATA_LIMIT = 100;             // Max missed events to send

  // State
  private clients: Map<string, SSEClient> = new Map();
  private ipConnectionCount: Map<string, number> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isSubscribed = false;

  private constructor() {}

  public static getInstance(): SSEManagerService {
    if (!SSEManagerService.instance) {
      SSEManagerService.instance = new SSEManagerService();
    }
    return SSEManagerService.instance;
  }

  /**
   * Initialize the SSE manager
   * - Subscribe to Redis pub/sub for cross-instance communication
   * - Start heartbeat timer
   */
  public async initialize(): Promise<void> {
    if (this.isSubscribed) return;

    // Subscribe to Redis channel for broadcast messages
    await redisService.subscribe(
      SSEManagerService.REDIS_CHANNEL,
      (message: string) => this.handleBroadcastMessage(message)
    );
    this.isSubscribed = true;

    // Start heartbeat
    this.startHeartbeat();

    logDeduplicator.info('SSE Manager initialized', {
      channel: SSEManagerService.REDIS_CHANNEL,
      heartbeatIntervalMs: SSEManagerService.HEARTBEAT_INTERVAL_MS
    });
  }

  /**
   * Add a new SSE client connection
   * Returns client ID on success, null if limits exceeded
   */
  public async addClient(
    res: Response,
    ip: string,
    filters: SSEClientFilters,
    lastEventId?: number
  ): Promise<string | null> {
    // Check connection limits
    if (this.clients.size >= SSEManagerService.MAX_TOTAL_CONNECTIONS) {
      logDeduplicator.warn('SSE max total connections reached', {
        current: this.clients.size,
        max: SSEManagerService.MAX_TOTAL_CONNECTIONS
      });
      return null;
    }

    const currentIpCount = this.ipConnectionCount.get(ip) || 0;
    if (currentIpCount >= SSEManagerService.MAX_CONNECTIONS_PER_IP) {
      logDeduplicator.warn('SSE max connections per IP reached', {
        ip,
        current: currentIpCount,
        max: SSEManagerService.MAX_CONNECTIONS_PER_IP
      });
      return null;
    }

    const clientId = randomUUID();
    const client: SSEClient = {
      id: clientId,
      res,
      filters,
      connectedAt: Date.now(),
      lastEventId: lastEventId || null,
      ip
    };

    this.clients.set(clientId, client);
    this.ipConnectionCount.set(ip, currentIpCount + 1);

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send connected event
    this.sendEvent(client, {
      type: 'connected',
      data: null,
      timestamp: new Date().toISOString()
    });

    // Send missed liquidations if reconnecting
    if (lastEventId) {
      await this.sendMissedLiquidations(client, lastEventId);
    }

    logDeduplicator.info('SSE client connected', {
      clientId,
      ip,
      filters,
      totalClients: this.clients.size
    });

    return clientId;
  }

  /**
   * Remove a client connection
   */
  public removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Update IP connection count
    const currentIpCount = this.ipConnectionCount.get(client.ip) || 0;
    if (currentIpCount <= 1) {
      this.ipConnectionCount.delete(client.ip);
    } else {
      this.ipConnectionCount.set(client.ip, currentIpCount - 1);
    }

    this.clients.delete(clientId);

    logDeduplicator.info('SSE client disconnected', {
      clientId,
      ip: client.ip,
      totalClients: this.clients.size
    });
  }

  /**
   * Broadcast new liquidations to all connected clients
   * Called by LiquidationsService when new data is detected
   */
  public async broadcastNewLiquidations(liquidations: Liquidation[]): Promise<void> {
    if (liquidations.length === 0) return;

    // Update last seen tid in Redis
    const maxTid = Math.max(...liquidations.map(l => l.tid));
    await redisService.set(
      SSEManagerService.LAST_TID_KEY,
      maxTid.toString()
    );

    // Publish to Redis for cross-instance communication
    const message: SSEBroadcastMessage = {
      newLiquidations: liquidations,
      timestamp: new Date().toISOString()
    };
    await redisService.publish(
      SSEManagerService.REDIS_CHANNEL,
      JSON.stringify(message)
    );

    logDeduplicator.info('SSE broadcast published', {
      count: liquidations.length,
      maxTid,
      connectedClients: this.clients.size
    });
  }

  /**
   * Get the last seen trade ID
   */
  public async getLastSeenTid(): Promise<number | null> {
    const tid = await redisService.get(SSEManagerService.LAST_TID_KEY);
    return tid ? parseInt(tid, 10) : null;
  }

  /**
   * Set the last seen trade ID (for initialization)
   */
  public async setLastSeenTid(tid: number): Promise<void> {
    await redisService.set(SSEManagerService.LAST_TID_KEY, tid.toString());
  }

  /**
   * Handle broadcast message from Redis pub/sub
   */
  private handleBroadcastMessage(messageStr: string): void {
    try {
      const message: SSEBroadcastMessage = JSON.parse(messageStr);

      for (const client of this.clients.values()) {
        const filteredLiquidations = this.filterLiquidations(
          message.newLiquidations,
          client.filters
        );

        if (filteredLiquidations.length > 0) {
          for (const liquidation of filteredLiquidations) {
            this.sendEvent(client, {
              type: 'liquidation',
              data: liquidation,
              id: liquidation.tid,
              timestamp: message.timestamp
            });
            client.lastEventId = liquidation.tid;
          }
        }
      }
    } catch (error) {
      logDeduplicator.error('SSE broadcast message parse error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Filter liquidations based on client preferences
   */
  private filterLiquidations(
    liquidations: Liquidation[],
    filters: SSEClientFilters
  ): Liquidation[] {
    return liquidations.filter(liq => {
      // Coin filter
      if (filters.coin && liq.coin.toUpperCase() !== filters.coin.toUpperCase()) {
        return false;
      }
      // Minimum amount filter
      if (filters.minAmountDollars && liq.notional_total < filters.minAmountDollars) {
        return false;
      }
      return true;
    });
  }

  /**
   * Send SSE event to a client
   */
  private sendEvent(client: SSEClient, event: SSELiquidationEvent): void {
    try {
      let message = '';

      if (event.id !== undefined) {
        message += `id: ${event.id}\n`;
      }
      message += `event: ${event.type}\n`;
      message += `data: ${JSON.stringify(event)}\n\n`;

      client.res.write(message);
    } catch (error) {
      // Client likely disconnected
      logDeduplicator.warn('SSE send failed, removing client', {
        clientId: client.id,
        error: error instanceof Error ? error.message : String(error)
      });
      this.removeClient(client.id);
    }
  }

  /**
   * Send missed liquidations on reconnection
   */
  private async sendMissedLiquidations(
    client: SSEClient,
    lastEventId: number
  ): Promise<void> {
    try {
      // Import dynamically to avoid circular dependency
      const { LiquidationsService } = await import('./liquidations.service');
      const liquidationsService = LiquidationsService.getInstance();

      // Fetch recent liquidations and filter by tid > lastEventId
      const response = await liquidationsService.getRecentLiquidations({
        hours: 1, // Only look back 1 hour for missed data
        limit: SSEManagerService.MISSED_DATA_LIMIT
      });

      const missedLiquidations = response.data
        .filter(liq => liq.tid > lastEventId)
        .sort((a, b) => a.tid - b.tid); // Send in chronological order

      const filteredMissed = this.filterLiquidations(
        missedLiquidations,
        client.filters
      );

      if (filteredMissed.length > 0) {
        for (const liquidation of filteredMissed) {
          this.sendEvent(client, {
            type: 'liquidation',
            data: liquidation,
            id: liquidation.tid,
            timestamp: new Date().toISOString()
          });
          client.lastEventId = liquidation.tid;
        }

        logDeduplicator.info('SSE sent missed liquidations', {
          clientId: client.id,
          count: filteredMissed.length
        });
      }
    } catch (error) {
      logDeduplicator.error('SSE failed to send missed liquidations', {
        clientId: client.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = new Date().toISOString();

      for (const client of this.clients.values()) {
        this.sendEvent(client, {
          type: 'heartbeat',
          data: null,
          timestamp: now
        });
      }
    }, SSEManagerService.HEARTBEAT_INTERVAL_MS);

    logDeduplicator.info('SSE heartbeat started', {
      intervalMs: SSEManagerService.HEARTBEAT_INTERVAL_MS
    });
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logDeduplicator.info('SSE heartbeat stopped');
    }
  }

  /**
   * Stop heartbeat and cleanup all connections
   */
  public shutdown(): void {
    this.stopHeartbeat();

    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.clients.clear();
    this.ipConnectionCount.clear();

    logDeduplicator.info('SSE Manager shutdown complete');
  }

  /**
   * Get current connection stats
   */
  public getStats(): SSEConnectionStats {
    return {
      totalConnections: this.clients.size,
      uniqueIps: this.ipConnectionCount.size
    };
  }
}
