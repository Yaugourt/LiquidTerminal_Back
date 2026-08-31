import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { logDeduplicator } from '../utils/logDeduplicator';
import { matchesAnyKey } from '../utils/constant-time-compare';
import { LiquidationsWebSocketService } from '../services/liquidations/liquidations.ws.service';
import { SSEManagerService } from '../services/liquidations/sse-manager.service';
import { L4BookService } from '../services/orderbook/l4book.service';
import { AggregatedLiquidation } from '../types/liquidations.types';
import { L4BookDeltaPayload, L4BookSnapshotPayload } from '../types/l4book.types';
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

  /**
   * Subscription types that carry another user's private data (Telegram chat
   * id, watched wallet addresses, PnL) and must NOT be readable by the public.
   * Only `liquidation` stays open — it is market data, same as the SSE feed.
   * A client may subscribe to these only after presenting the bot API key on
   * the upgrade request.
   */
  private static readonly PRIVILEGED_SUBSCRIPTIONS: ReadonlySet<string> = new Set([
    'wallet_event',
    'liquidation_alert',
    'fill_alert',
    'doc_update_alert',
    'bot_announcement',
  ]);

  /**
   * L4 books are expensive to mirror (a few MB of resident state each), so a
   * single client cannot pin an unbounded number of them.
   */
  private static readonly MAX_L4_COINS_PER_CLIENT = 4;
  /** Coin ids across perps (`BTC`), spot (`@107`, `PURR/USDC`), HIP-3 (`xyz:SKHX`) and HIP-4 (`#10250`). */
  private static readonly L4_COIN_PATTERN = /^[A-Za-z0-9@#:/_.-]{1,32}$/;

  // Heartbeat
  private static readonly HEARTBEAT_INTERVAL_MS = 30000;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Services
  private liquidationsWSService: LiquidationsWebSocketService | null = null;
  private sseManager: SSEManagerService | null = null;
  private l4BookService: L4BookService | null = null;

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

    // L4 order books — fanned out per coin to whoever is watching that coin.
    // The service itself only mirrors a coin while at least one client holds it.
    this.l4BookService = L4BookService.getInstance();
    this.l4BookService.onSnapshot((payload) => this.broadcastL4Snapshot(payload));
    this.l4BookService.onDelta((payload) => this.broadcastL4Delta(payload));
    this.l4BookService.onUnavailable((coin) => this.broadcastL4Unavailable(coin));

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

    // Drops the mirrored books and the upstream HypeDexer socket with them.
    this.l4BookService?.shutdown();
    this.l4BookService = null;

    logDeduplicator.info('InternalWebSocketServer: Shutdown complete');
  }

  /**
   * Get connection statistics
   */
  public getStats(): WSConnectionStats {
    let authenticatedCount = 0;
    const subscriptionCounts: Record<string, number> = {
      liquidation: 0,
      l4book: 0,
      wallet_event: 0,
      liquidation_alert: 0,
      fill_alert: 0,
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
   * Resolve the real client IP behind Railway's single edge proxy.
   *
   * The proxy APPENDS the real client address to the right of any
   * `X-Forwarded-For` the client sent, so the RIGHTMOST entry is the one the
   * client cannot forge — mirroring the HTTP app's `trust proxy: 1`. The old
   * code took the leftmost entry, which is fully attacker-controlled and let a
   * single host masquerade as unlimited distinct IPs to bypass the per-IP cap.
   */
  private resolveClientIp(req: IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * True when the upgrade request carries a valid bot API key, granting access
   * to the privileged alert channels. Accepts the same `Authorization: Bot
   * <key>` scheme the bot already uses for HTTP, plus a `?key=` query fallback
   * for WS clients that cannot set upgrade headers. Compared in constant time.
   */
  private isBotUpgrade(req: IncomingMessage): boolean {
    const validKeys = [
      process.env.TELEGRAM_BOT_API_KEY,
      process.env.TELEGRAM_BOT_API_KEY_SECONDARY,
    ].filter(Boolean) as string[];
    if (validKeys.length === 0) return false;

    const authHeader = req.headers['authorization'];
    let provided: string | undefined;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bot ')) {
      provided = authHeader.slice(4);
    } else if (req.url) {
      // req.url is path + query only; a fixed base is fine for parsing.
      const key = new URL(req.url, 'http://localhost').searchParams.get('key');
      if (key) provided = key;
    }
    if (!provided) return false;
    return matchesAnyKey(provided, validKeys);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this.resolveClientIp(req);

    // Check connection limits
    if (!this.checkConnectionLimits(ip)) {
      ws.close(1008, 'Connection limit exceeded');
      return;
    }

    // Authenticate the upgrade against the bot API key. The Telegram bot is the
    // only legitimate consumer of the privileged alert channels; anyone else
    // connects unauthenticated and is limited to public market data.
    const isAuthenticated = this.isBotUpgrade(req);

    // Create client
    const clientId = randomUUID();
    const client: WSClient = {
      id: clientId,
      ip,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      subscriptions: [],
      isAuthenticated,
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
        subType !== 'l4book' &&
        subType !== 'wallet_event' &&
        subType !== 'liquidation_alert' &&
        subType !== 'fill_alert' &&
        subType !== 'doc_update_alert' &&
        subType !== 'bot_announcement')
    ) {
      this.sendMessage(ws, {
        type: 'error',
        error:
          'Invalid subscription type. Supported: liquidation, l4book, wallet_event, liquidation_alert, fill_alert, doc_update_alert, bot_announcement',
        code: 'INVALID_SUBSCRIPTION',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Privileged channels carry another user's private data — refuse them to
    // any client that did not authenticate on the upgrade. `liquidation` (public
    // market data) is intentionally exempt.
    if (InternalWebSocketServer.PRIVILEGED_SUBSCRIPTIONS.has(subType) && !client.isAuthenticated) {
      logDeduplicator.warn('InternalWebSocketServer: Unauthenticated privileged subscription refused', {
        clientId: client.id,
        ip: client.ip,
        subType,
      });
      this.sendMessage(ws, {
        type: 'error',
        error: 'Authentication required for this subscription',
        code: 'UNAUTHORIZED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // `l4book` is coin-scoped rather than one-per-type: a client holds one
    // subscription per coin, each reference-counted in the book service.
    if (subType === 'l4book') {
      this.handleL4BookSubscribe(ws, client, message.subscription?.coin);
      return;
    }

    // Check if already subscribed to this type
    const existingIndex = client.subscriptions.findIndex((s) => s.type === subType);
    if (existingIndex >= 0) {
      // Update existing subscription filters (wallet_event, liquidation_alert have no filters)
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
        subType !== 'l4book' &&
        subType !== 'wallet_event' &&
        subType !== 'liquidation_alert' &&
        subType !== 'fill_alert' &&
        subType !== 'doc_update_alert' &&
        subType !== 'bot_announcement')
    ) {
      this.sendMessage(ws, {
        type: 'error',
        error:
          'Invalid subscription type. Supported: liquidation, l4book, wallet_event, liquidation_alert, fill_alert, doc_update_alert, bot_announcement',
        code: 'INVALID_SUBSCRIPTION',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (subType === 'l4book') {
      // No coin given ⇒ drop every book this client holds.
      const coin = message.subscription?.coin;
      this.releaseL4Books(client, coin);
    } else {
      const index = client.subscriptions.findIndex((s) => s.type === subType);
      if (index >= 0) {
        client.subscriptions.splice(index, 1);
      }
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

    // Release every mirrored book this client held, or the service keeps
    // paying for upstream feeds nobody is watching.
    this.releaseL4Books(client);

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

  // ============================================================================
  // L4 ORDER BOOKS
  // ============================================================================

  /**
   * Subscribe a client to one coin's L4 book. Answers immediately with a
   * snapshot when the book is already warm, so a viewer joining a coin someone
   * else is already watching renders without waiting for upstream.
   */
  private handleL4BookSubscribe(ws: WebSocket, client: WSClient, coin?: string): void {
    if (!coin || !InternalWebSocketServer.L4_COIN_PATTERN.test(coin)) {
      this.sendMessage(ws, {
        type: 'error',
        error: 'l4book requires a valid `coin` (e.g. "BTC", "@107", "xyz:SKHX", "#10250")',
        code: 'INVALID_COIN',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const normalized = coin.toLowerCase();
    const held = client.subscriptions.filter((s) => s.type === 'l4book');

    if (held.some((s) => s.coin?.toLowerCase() === normalized)) {
      // Already watching this coin — re-send the current book rather than
      // taking a second reference.
      const existing = this.l4BookService?.getSnapshot(coin);
      if (existing) this.sendL4Snapshot(ws, existing);
      return;
    }

    if (held.length >= InternalWebSocketServer.MAX_L4_COINS_PER_CLIENT) {
      this.sendMessage(ws, {
        type: 'error',
        error: `At most ${InternalWebSocketServer.MAX_L4_COINS_PER_CLIENT} order books per connection`,
        code: 'TOO_MANY_BOOKS',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const service = this.l4BookService ?? L4BookService.getInstance();
    const snapshot = service.acquire(coin);

    // `acquire` returns null both while the first snapshot is in flight and
    // when the mirror is at capacity; `books` distinguishes them.
    if (snapshot === null && !service.getStats().some((s) => s.coin.toLowerCase() === normalized)) {
      this.sendMessage(ws, {
        type: 'error',
        error: 'Order book capacity reached, try again shortly',
        code: 'BOOK_CAPACITY',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    client.subscriptions.push({
      type: 'l4book',
      filters: {},
      coin,
      subscribedAt: Date.now(),
    });

    this.sendMessage(ws, {
      type: 'subscribed',
      data: { type: 'l4book', coin },
      timestamp: new Date().toISOString(),
    });

    if (snapshot) this.sendL4Snapshot(ws, snapshot);

    logDeduplicator.info('InternalWebSocketServer: Client subscribed to l4book', {
      clientId: client.id,
      coin,
      warm: snapshot !== null,
    });
  }

  /**
   * Release this client's L4 books — one coin when given, otherwise all of
   * them (unsubscribe-all, or disconnect).
   */
  private releaseL4Books(client: WSClient, coin?: string): void {
    const service = this.l4BookService;
    const normalized = coin?.toLowerCase();

    for (let i = client.subscriptions.length - 1; i >= 0; i--) {
      const sub = client.subscriptions[i];
      if (sub.type !== 'l4book') continue;
      if (normalized && sub.coin?.toLowerCase() !== normalized) continue;

      client.subscriptions.splice(i, 1);
      if (sub.coin) service?.release(sub.coin);
    }
  }

  private sendL4Snapshot(ws: WebSocket, payload: L4BookSnapshotPayload): void {
    this.sendMessage(ws, {
      type: 'l4book_snapshot',
      data: payload,
      timestamp: new Date().toISOString(),
    });
  }

  /** Fan a book frame out to every client watching that coin. */
  private broadcastL4(
    coin: string,
    type: 'l4book_snapshot' | 'l4book_delta' | 'l4book_unavailable',
    data: unknown
  ): void {
    if (!this.wss) return;

    const normalized = coin.toLowerCase();
    const serialized = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      if (!client.subscriptions.some((s) => s.type === 'l4book' && s.coin?.toLowerCase() === normalized)) {
        continue;
      }
      this.sendRawMessage(ws, serialized);
    }
  }

  private broadcastL4Snapshot(payload: L4BookSnapshotPayload): void {
    this.broadcastL4(payload.coin, 'l4book_snapshot', payload);
  }

  private broadcastL4Delta(payload: L4BookDeltaPayload): void {
    this.broadcastL4(payload.coin, 'l4book_delta', payload);
  }

  private broadcastL4Unavailable(coin: string): void {
    this.broadcastL4(coin, 'l4book_unavailable', { coin, reason: 'no_book' });
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
   * Broadcast a fill alert to all clients subscribed to 'fill_alert'.
   * The Telegram bot (1 connected client) receives the event and routes it
   * to the correct Telegram user via telegramId in the payload.
   */
  public broadcastFillAlert(telegramId: string, message: string): number {
    if (!this.wss) return 0;

    const serialized = JSON.stringify({
      type: 'fill_alert',
      data: { telegramId, message },
      timestamp: new Date().toISOString(),
    } satisfies WSServerMessage);

    let sentCount = 0;

    for (const [ws, clientId] of this.clientsBySocket) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      const hasSub = client.subscriptions.some((s) => s.type === 'fill_alert');
      if (!hasSub) continue;

      this.sendRawMessage(ws, serialized);
      sentCount++;
    }

    if (sentCount > 0) {
      logDeduplicator.info('InternalWebSocketServer: Broadcast fill alert', {
        telegramId,
        clientCount: sentCount,
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
