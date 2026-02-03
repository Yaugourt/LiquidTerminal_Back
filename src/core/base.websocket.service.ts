import WebSocket from 'ws';
import { logDeduplicator } from '../utils/logDeduplicator';
import { WSClientConfig, WSClientEvents, WSConnectionState } from '../types/websocket.types';

/**
 * Base WebSocket Service
 * Provides common WebSocket functionality with reconnection, heartbeat, and error handling
 * Extend this class for specific WebSocket clients (e.g., HypeDexer)
 */
export abstract class BaseWebSocketService {
  protected ws: WebSocket | null = null;
  protected state: WSConnectionState = 'disconnected';
  protected reconnectAttempts = 0;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected pingTimer: NodeJS.Timeout | null = null;
  protected pongTimer: NodeJS.Timeout | null = null;
  protected messageBuffer: string[] = [];
  protected isIntentionalClose = false;

  // Default configuration
  protected readonly config: Required<WSClientConfig>;
  protected readonly events: WSClientEvents;

  // Default config values
  private static readonly DEFAULT_CONFIG: Required<Omit<WSClientConfig, 'url' | 'headers'>> = {
    reconnect: true,
    reconnectInterval: 5000,       // 5 seconds
    reconnectMaxInterval: 60000,   // 60 seconds max
    reconnectMaxAttempts: 0,       // 0 = infinite
    pingInterval: 30000,           // 30 seconds
    pingTimeout: 10000,            // 10 seconds
    maxBufferSize: 100 * 1024,     // 100KB
  };

  constructor(config: WSClientConfig, events: WSClientEvents = {}) {
    this.config = {
      ...BaseWebSocketService.DEFAULT_CONFIG,
      ...config,
      headers: config.headers || {},
    } as Required<WSClientConfig>;
    this.events = events;
  }

  /**
   * Get current connection state
   */
  public getState(): WSConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to WebSocket server
   */
  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      logDeduplicator.warn(`${this.constructor.name}: Already connected or connecting`);
      return;
    }

    this.isIntentionalClose = false;
    this.setState('connecting');

    try {
      logDeduplicator.info(`${this.constructor.name}: Connecting to ${this.config.url}`);

      this.ws = new WebSocket(this.config.url, {
        headers: this.config.headers,
      });

      this.setupEventHandlers();
    } catch (error) {
      logDeduplicator.error(`${this.constructor.name}: Connection error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.setState('error');
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  public disconnect(): void {
    this.isIntentionalClose = true;
    this.cleanup();

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.setState('disconnected');
    logDeduplicator.info(`${this.constructor.name}: Disconnected`);
  }

  /**
   * Send message to WebSocket server
   */
  public send(data: unknown): boolean {
    if (!this.isConnected()) {
      logDeduplicator.warn(`${this.constructor.name}: Cannot send - not connected`);
      return false;
    }

    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws!.send(message);
      return true;
    } catch (error) {
      logDeduplicator.error(`${this.constructor.name}: Send error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));
    this.ws.on('error', (error) => this.handleError(error));
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('pong', () => this.handlePong());
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    logDeduplicator.info(`${this.constructor.name}: Connected`);
    this.setState('connected');
    this.reconnectAttempts = 0;

    // Start ping interval
    this.startPingInterval();

    // Flush message buffer
    this.flushMessageBuffer();

    // Call custom open handler
    this.onOpen();
    this.events.onOpen?.();
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(code: number, reason: string): void {
    logDeduplicator.info(`${this.constructor.name}: Connection closed`, { code, reason });

    this.cleanup();
    this.events.onClose?.(code, reason);

    if (!this.isIntentionalClose && this.config.reconnect) {
      this.scheduleReconnect();
    } else {
      this.setState('disconnected');
    }
  }

  /**
   * Handle WebSocket error event
   */
  private handleError(error: Error): void {
    logDeduplicator.error(`${this.constructor.name}: WebSocket error`, {
      error: error.message,
    });

    this.events.onError?.(error);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = data.toString();

      // Check buffer size limit
      if (message.length > this.config.maxBufferSize) {
        logDeduplicator.warn(`${this.constructor.name}: Message too large, ignoring`, {
          size: message.length,
          maxSize: this.config.maxBufferSize,
        });
        return;
      }

      // Parse JSON
      const parsed = JSON.parse(message);

      // Call custom message handler
      this.onMessage(parsed);
      this.events.onMessage?.(parsed);
    } catch (error) {
      logDeduplicator.error(`${this.constructor.name}: Message parse error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle pong response
   */
  private handlePong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Start ping interval
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingTimer = setInterval(() => {
      if (this.isConnected()) {
        this.ws!.ping();

        // Set pong timeout
        this.pongTimer = setTimeout(() => {
          logDeduplicator.warn(`${this.constructor.name}: Pong timeout, reconnecting`);
          this.ws?.terminate();
        }, this.config.pingTimeout);
      }
    }, this.config.pingInterval);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.config.reconnectMaxAttempts > 0 && this.reconnectAttempts >= this.config.reconnectMaxAttempts) {
      logDeduplicator.error(`${this.constructor.name}: Max reconnect attempts reached`);
      this.setState('error');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      this.config.reconnectMaxInterval
    );

    logDeduplicator.info(`${this.constructor.name}: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.events.onReconnect?.(this.reconnectAttempts);
      this.connect();
    }, delay);
  }

  /**
   * Flush buffered messages
   */
  private flushMessageBuffer(): void {
    while (this.messageBuffer.length > 0 && this.isConnected()) {
      const message = this.messageBuffer.shift();
      if (message) {
        this.ws!.send(message);
      }
    }
  }

  /**
   * Cleanup timers and state
   */
  private cleanup(): void {
    this.stopPingInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Set connection state and notify
   */
  protected setState(state: WSConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onStateChange?.(state);
    }
  }

  // ============================================================================
  // ABSTRACT METHODS - Override in subclasses
  // ============================================================================

  /**
   * Called when connection is established
   * Override to send initial subscriptions
   */
  protected abstract onOpen(): void;

  /**
   * Called when a message is received
   * Override to handle specific message types
   */
  protected abstract onMessage(data: unknown): void;
}
