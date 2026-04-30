import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { logDeduplicator } from '../utils/logDeduplicator';
import { LiquidationsWebSocketService } from '../services/liquidations/liquidations.ws.service';
import { SSEManagerService } from '../services/liquidations/sse-manager.service';
import { AggregatedLiquidation } from '../types/liquidations.types';
import {
  WSClient,
  WSClientMessage,
  WSServerMessage,
  WSLiquidationFilters,
  WSConnectionStats,
} from '../types/websocket.types';
import { CompletedTrade } from '../types/wallet-events.types';

/**
 * Internal WebSocket Server
 * 
 * Exposes our own WebSocket API at /ws for clients (Bot Telegram, Frontend, etc.)
 * 
 * Features:
 * - Public access (no auth required for liquidations - same as SSE)
 * - Rate limiting per IP
 * - Subscription-based filtering
 * - Heartbeat for connection health
 * - Bridges data from LiquidationsWebSocketService
 */
export class InternalWebSocketServer {
  private static instance: InternalWebSocketServer;

  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private clientsBySocket: Map<WebSocket, string> = new Map();
  private ipConnectionCount: Map<string, number> = new Map();

  // Rate limiting
  private static readonly MAX_CONNECTIONS_PER_IP = 5;
  private static readonly MAX_TOTAL_CONNECTIONS = 1000;
  private static readonly MAX_MESSAGES_PER_SECOND = 10;
  private messageCounters: Map<string, { count: number; resetAt: number }> = new Map();

  // Heartbeat
  private static readonly HEARTBEAT_INTERVAL_MS = 30000;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Services
  private liquidationsWSService: LiquidationsWebSocketService | null = null;
  private sseManager: SSEManagerService | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): InternalWebSocketServer {
    if (!InternalWebSocketServer.instance) {
      InternalWebSocketServer.instance = new InternalWebSocketServer();
    }
    return InternalWebSocketServer.instance;
  }

  /**
   * Initialize and attach to HTTP server
   */
  public initialize(httpServer: HTTPServer): void {
    if (this.wss) {
      logDeduplicator.warn('InternalWebSocketServer: Already initialized');
      return;
    }

    // Create WebSocket server attached to HTTP server at /ws path
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: 64 * 1024, // 64KB max message size
    });

    // Setup event handlers
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (error) => this.handleServerError(error));

    // Start heartbeat
    this.startHeartbeat();

    // Subscribe to liquidation events from LiquidationsWebSocketService
    this.liquidationsWSService = LiquidationsWebSocketService.getInstance();
    this.liquidationsWSService.onProcessedLiquidation((liquidations) => {
      this.broadcastLiquidations(liquidations);
    });

    // Also subscribe to SSE manager for backward compatibility during migration
    this.sseManager = SSEManagerService.getInstance();

    logDeduplicator.info('InternalWebSocketServer: Initialized', {
      path: '/ws',
      maxPayload: '64KB',
    });
  }

  /**
   * Shutdown the WebSocket server
   */
  public shutdown(): void {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all client connections
    for (const [, ws] of this.clientsBySocket.entries()) {
      const client = this.clients.get(ws);
      if (client) {
        // Note: ws is the client ID here, need to get actual socket
      }
    }

    // Close all sockets
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.close(1001, 'Server shutdown');
      }
      this.wss.close();
      this.wss = null;
    }

    this.clients.clear();
    this.clientsBySocket.clear();
    this.ipConnectionCount.clear();
    this.messageCounters.clear();

    logDeduplicator.info('InternalWebSocketServer: Shutdown complete');
  }

  /**
   * Get connection statistics
   */
  public getStats(): WSConnectionStats {
    let authenticatedCount = 0;
    const subscriptionCounts: Record<string, number> = {
      liquidation: 0,
      wallet_event: 0,
      liquidation_alert: 0,
      hip4_event_alert: 0,
      doc_update_alert: 0,
      bot_announcement: 0,
    };

    for (const client of this.clients.values()) {
      if (client.isAuthenticated) {
        authenticatedCount++;
      }
      for (const sub of client.subscriptions) {
        subscriptionCounts[sub.type] = (subscriptionCounts[sub.type] || 0) + 1;
      }
    }

    return {
      totalConnections: this.clients.size,
      authenticatedConnections: authenticatedCount,
      uniqueIps: this.ipConnectionCount.size,
      subscriptionsByType: subscriptionCounts,
      messagesPerSecond: 0, // TODO: track this
      uptime: process.uptime(),
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : undefined) || 
               req.socket.remoteAddress || 
               'unknown';

    // Check connection limits
    if (!this.checkConnectionLimits(ip)) {
      ws.close(1008, 'Connection limit exceeded');
      return;
    }

    // Create client
    const clientId = randomUUID();
    const client: WSClient = {
      id: clientId,
      ip,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      subscriptions: [],
      isAuthenticated: false,
    };

    this.clients.set(clientId, client);
    this.clientsBySocket.set(ws, clientId);
    this.incrementIpCount(ip);

    // Setup socket event handlers
    ws.on('message', (data) => this.handleMessage(ws, clientId, data));
    ws.on('close', (code, reason) => this.handleClose(ws, clientId, code, reason.toString()));
    ws.on('error', (error) => this.handleClientError(ws, clientId, error));
    ws.on('pong', () => this.handlePong(clientId));

    // Send connected message
    this.sendMessage(ws, {
      type: 'connected',
      data: { clientId },
      timestamp: new Date().toISOString(),
    });

    logDeduplicator.info('InternalWebSocketServer: Client connected', {
      clientId,
      ip,
      totalClients: this.clients.size,
    });
  }

  /**
   * Handle incoming message from client
   */
  private handleMessage(ws: WebSocket, clientId: string, data: Buffer | ArrayBuffer | Buffer[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Rate limiting
    if (!this.checkMessageRateLimit(clientId)) {
      this.sendMessage(ws, {
        type: 'error',
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    client.lastActivity = Date.now();

    try {
      const message: WSClientMessage = JSON.parse(data.toString());

      switch (message.method) {
        case 'subscribe':
          this.handleSubscribe(ws, client, message);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(ws, client, message);
          break;

        case 'ping':
          this.sendMessage(ws, {
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
          });
          break;

        default:
          this.sendMessage(ws, {
            type: 'error',
            error: `Unknown method: ${(message as { method?: string }).method}`,
            code: 'UNKNOWN_METHOD',
            timestamp: new Date().toISOString(),
          });
      }
    } catch (error) {
      this.sendMessage(ws, {
        type: 'error',
        error: 'Invalid message format',
        code: 'INVALID_FORMAT',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Handle subscribe request
   */
  private handleSubscribe(ws: WebSocket, client: WSClient, message: WSClientMessage): void {
    const subType = message.subscription?.type;

    if (
      !subType ||
      (subType !== 'liquidation' &&
        subType !== 'wallet_event' &&
        subType !== 'liquidation_alert' &&
        subType !== 'hip4_event_alert' &&
        subType !== 'doc_update_alert' &&
        subType !== 'bot_announcement')
    ) {
      this.sendMessage(ws, {
        type: 'error',
        error:
          'Invalid subscription type. Supported: liquidation, wallet_event, liquidation_alert, hip4_event_alert, doc_update_alert, bot_announcement',
        code: 'INVALID_SUBSCRIPTION',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if already subscribed to this type
    const existingIndex = client.subscriptions.findIndex((s) => s.type === subType);
    if (existingIndex >= 0) {
      // Update existing subscription filters (wallet_event, liquidation_alert, hip4_event_alert have no filters)
      if (subType === 'liquidation') {
        client.subscriptions[existingIndex].filters = message.subscription?.filters || {};
      }
    } else {
      // Add new subscription
      client.subscriptions.push({
        type: subType,
        filters: message.subscription?.filters || {},
        subscribedAt: Date.now(),
      });
    }

    this.sendMessage(ws, {
      type: 'subscribed',
      data: {
        type: subType,
        filters: subType === 'liquidation' ? (message.subscription?.filters || {}) : {},
      },
      timestamp: new Date().toISOString(),
    });

    logDeduplicator.info('InternalWebSocketServer: Client subscribed', {
      clientId: client.id,
      type: subType,
    });

    if (subType === 'hip4_event_alert') {
      logDeduplicator.info(
        'InternalWebSocketServer: [hip4_ws] Bot (or client) subscribed to hip4_event_alert — will receive HIP-4 Telegram fan-out',
        { clientId: client.id, ip: client.ip }
      );
    }

    if (subType === 'doc_update_alert') {
      logDeduplicator.info(
        'InternalWebSocketServer: [doc_ws] Bot subscribed to doc_update_alert — will receive Hyperliquid docs update fan-out',
        { clientId: client.id, ip: client.ip }
      );
    }

    if (subType === 'bot_announcement') {
      logDeduplicator.info(
        'InternalWebSocketServer: [announce_ws] Bot subscribed to bot_announcement — will receive changelog broadcasts',
        { clientId: client.id, ip: client.ip }
      );
    }
  }

  /**
   * Handle unsubscribe request
   */
  private handleUnsubscribe(ws: WebSocket, client: WSClient, message: WSClientMessage): void {
    const subType = message.subscription?.type;

    if (
      !subType ||
      (subType !== 'liquidation' &&
        subType !== 'wallet_event' &&
        subType !== 'liquidation_alert' &&
        subType !== 'hip4_event_alert' &&
        subType !== 'doc_update_alert' &&
        subType !== 'bot_announcement')
    ) {
      this.sendMessage(ws, {
        type: 'error',
        error:
          'Invalid subscription type. Supported: liquidation, wallet_event, liquidation_alert, hip4_event_alert, doc_update_alert, bot_announcement',
        code: 'INVALID_SUBSCRIPTION',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const index = client.subscriptions.findIndex((s) => s.type === subType);
    if (index >= 0) {
      client.subscriptions.splice(index, 1);
    }

    this.sendMessage(ws, {
      type: 'unsubscribed',
      data: { type: subType },
      timestamp: new Date().toISOString(),
    });

    logDeduplicator.info('InternalWebSocketServer: Client unsubscribed', {
      clientId: client.id,
      type: subType,
    });
  }

  /**
   * Handle client disconnect
   */
  private handleClose(ws: WebSocket, clientId: string, code: number, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.decrementIpCount(client.ip);
    this.clients.delete(clientId);
    this.clientsBySocket.delete(ws);
    this.messageCounters.delete(clientId);

    logDeduplicator.info('InternalWebSocketServer: Client disconnected', {
      clientId,
      code,
      reason,
      totalClients: this.clients.size,
    });
  }

  /**
   * Handle client error
   */
  private handleClientError(ws: WebSocket, clientId: string, error: Error): void {
    logDeduplicator.error('InternalWebSocketServer: Client error', {
      clientId,
      error: error.message,
    });
  }

  /**
   * Handle pong response
   */
  private handlePong(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastActivity = Date.now();
    }
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    logDeduplicator.error('InternalWebSocketServer: Server error', {
      error: error.message,
    });
  }

  /**
   * Broadcast liquidations to all subscribed clients
   * Pre-serializes each message once to avoid redundant JSON.stringify per client.
   */
  private broadcastLiquidations(liquidations: AggregatedLiquidation[]): void {
    if (!this.wss || liquidations.length === 0) return;

    // Pre-serialize each liquidation message once before the client loop
    const timestamp = new Date().toISOString();
    const serializedMessages = liquidations.map((liq) => ({
      liq,
      serialized: JSON.stringify({
        type: 'liquidation',
        data: liq,
        timestamp,
      } satisfies WSServerMessage),
    }));

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      // Check if client is subscribed to liquidations
      const subscription = client.subscriptions.find((s) => s.type === 'liquidation');
      if (!subscription) continue;

      const filters = subscription.filters;
      const hasFilters =
        (filters.coins && filters.coins.length > 0) ||
        (filters.minAmountUsd !== undefined && filters.minAmountUsd !== null) ||
        (filters.wallets && filters.wallets.length > 0);

      if (hasFilters) {
        // Filter first, then send matching pre-serialized messages
        const filtered = serializedMessages.filter((m) =>
          this.matchesFilters(m.liq, filters)
        );
        if (filtered.length === 0) continue;

        for (const { serialized } of filtered) {
          this.sendRawMessage(ws, serialized);
        }
      } else {
        // No filters — send all pre-serialized messages directly
        for (const { serialized } of serializedMessages) {
          this.sendRawMessage(ws, serialized);
        }
      }

      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast liquidations', {
        liquidationCount: liquidations.length,
        clientCount: sentCount,
      });
    }
  }

  /**
   * Broadcast a wallet event to all clients subscribed to 'wallet_event'.
   * The Telegram bot (1 connected client) receives the event and routes it
   * to the correct Telegram user via telegramId in the payload.
   */
  public broadcastWalletEvent(
    telegramId: string,
    trade: CompletedTrade,
    subscriptionName: string
  ): void {
    if (!this.wss) return;

    const serialized = JSON.stringify({
      type: 'wallet_event',
      data: { telegramId, trade, subscriptionName },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      const hasSub = client.subscriptions.some((s) => s.type === 'wallet_event');
      if (!hasSub) continue;

      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast wallet event', {
        telegramId,
        tradeId: trade.tradeId,
        coin: trade.coin,
        clientCount: sentCount,
      });
    }
  }

  /**
   * Broadcast a liquidation alert to all clients subscribed to 'liquidation_alert'.
   * The Telegram bot (1 connected client) receives the event and routes it
   * to the correct Telegram user via telegramId in the payload.
   */
  public broadcastLiquidationAlert(telegramId: string, message: string): number {
    if (!this.wss) return 0;

    const serialized = JSON.stringify({
      type: 'liquidation_alert',
      data: { telegramId, message },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      const hasSub = client.subscriptions.some((s) => s.type === 'liquidation_alert');
      if (!hasSub) continue;

      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast liquidation alert', {
        telegramId,
        clientCount: sentCount,
      });
    }

    return sentCount;
  }

  /**
   * Broadcast HIP-4 alert to clients subscribed to `hip4_event_alert` (Telegram bot).
   * @returns Number of WebSocket clients that received the message (0 = no subscriber — bot may be down).
   */
  public broadcastHip4EventAlert(telegramId: string, message: string): number {
    if (!this.wss) return 0;

    const serialized = JSON.stringify({
      type: 'hip4_event_alert',
      data: { telegramId, message },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      const hasSub = client.subscriptions.some((s) => s.type === 'hip4_event_alert');
      if (!hasSub) continue;

      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast HIP-4 event alert', {
        telegramId,
        clientCount: sentCount,
      });
    } else {
      logDeduplicator.warn('InternalWebSocketServer: [hip4_ws] Broadcast HIP-4 alert to 0 clients (no hip4_event_alert subscriber — Telegram bot disconnected?)', {
        telegramId,
      });
    }

    return sentCount;
  }

  /**
   * Broadcast bot changelog announcement to clients subscribed to `bot_announcement` (Telegram bot).
   * @returns Number of WebSocket clients that received the message.
   */
  public broadcastBotAnnouncement(telegramId: string, message: string): number {
    if (!this.wss) return 0;

    const serialized = JSON.stringify({
      type: 'bot_announcement',
      data: { telegramId, message },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      if (!client.subscriptions.some((s) => s.type === 'bot_announcement')) continue;
      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount === 0) {
      logDeduplicator.warn('InternalWebSocketServer: [announce_ws] Broadcast bot announcement to 0 clients (bot disconnected?)', {
        telegramId,
      });
    }

    return sentCount;
  }

  /**
   * Broadcast Hyperliquid doc update alert to clients subscribed to `doc_update_alert` (Telegram bot).
   * @returns Number of WebSocket clients that received the message.
   */
  public broadcastDocUpdateAlert(telegramId: string, message: string): number {
    if (!this.wss) return 0;

    const serialized = JSON.stringify({
      type: 'doc_update_alert',
      data: { telegramId, message },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      const hasSub = client.subscriptions.some((s) => s.type === 'doc_update_alert');
      if (!hasSub) continue;

      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast doc update alert', {
        telegramId,
        clientCount: sentCount,
      });
    } else {
      logDeduplicator.warn('InternalWebSocketServer: [doc_ws] Broadcast doc update alert to 0 clients (bot disconnected?)', {
        telegramId,
      });
    }

    return sentCount;
  }

  /**
   * Check if a single liquidation matches the client's subscription filters
   */
  private matchesFilters(
    liq: AggregatedLiquidation,
    filters: WSLiquidationFilters
  ): boolean {
    // Filter by coins
    if (filters.coins && filters.coins.length > 0) {
      if (!filters.coins.some((c) => c.toUpperCase() === liq.coin.toUpperCase())) {
        return false;
      }
    }

    // Filter by minimum amount
    if (filters.minAmountUsd && liq.notional_total < filters.minAmountUsd) {
      return false;
    }

    // Filter by wallets
    if (filters.wallets && filters.wallets.length > 0) {
      if (!filters.wallets.some((w) => w.toLowerCase() === liq.liquidated_user.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Send message to client
   */
  private sendMessage(ws: WebSocket, message: WSServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      logDeduplicator.error('InternalWebSocketServer: Send error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send a pre-serialized message string to client (avoids redundant JSON.stringify)
   */
  private sendRawMessage(ws: WebSocket, serialized: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(serialized);
    } catch (error) {
      logDeduplicator.error('InternalWebSocketServer: Send error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = InternalWebSocketServer.HEARTBEAT_INTERVAL_MS * 2;

      for (const [ws, clientId] of this.clientsBySocket) {
        const client = this.clients.get(clientId);
        if (!client) continue;

        // Check for inactive clients
        if (now - client.lastActivity > timeout) {
          logDeduplicator.info('InternalWebSocketServer: Closing inactive client', {
            clientId,
            lastActivity: client.lastActivity,
          });
          ws.close(1000, 'Inactive');
          continue;
        }

        // Send ping
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, InternalWebSocketServer.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Check connection limits
   */
  private checkConnectionLimits(ip: string): boolean {
    // Check total connections
    if (this.clients.size >= InternalWebSocketServer.MAX_TOTAL_CONNECTIONS) {
      logDeduplicator.warn('InternalWebSocketServer: Max total connections reached');
      return false;
    }

    // Check per-IP connections
    const ipCount = this.ipConnectionCount.get(ip) || 0;
    if (ipCount >= InternalWebSocketServer.MAX_CONNECTIONS_PER_IP) {
      logDeduplicator.warn('InternalWebSocketServer: Max connections per IP reached', { ip });
      return false;
    }

    return true;
  }

  /**
   * Check message rate limit
   */
  private checkMessageRateLimit(clientId: string): boolean {
    const now = Date.now();
    const counter = this.messageCounters.get(clientId);

    if (!counter || now > counter.resetAt) {
      this.messageCounters.set(clientId, {
        count: 1,
        resetAt: now + 1000,
      });
      return true;
    }

    if (counter.count >= InternalWebSocketServer.MAX_MESSAGES_PER_SECOND) {
      return false;
    }

    counter.count++;
    return true;
  }

  /**
   * Increment IP connection count
   */
  private incrementIpCount(ip: string): void {
    const count = this.ipConnectionCount.get(ip) || 0;
    this.ipConnectionCount.set(ip, count + 1);
  }

  /**
   * Decrement IP connection count
   */
  private decrementIpCount(ip: string): void {
    const count = this.ipConnectionCount.get(ip) || 0;
    if (count <= 1) {
      this.ipConnectionCount.delete(ip);
    } else {
      this.ipConnectionCount.set(ip, count - 1);
    }
  }
}
