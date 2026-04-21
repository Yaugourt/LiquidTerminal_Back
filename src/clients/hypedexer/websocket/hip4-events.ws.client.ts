import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  Hip4EventCallback,
  Hip4EventPayload,
  HypeDexerHip4EventsMessage,
} from '../../../types/hip4-events.types';
import { buildHip4EventDedupeKey } from '../../../utils/telegram.hip4';

/**
 * HypeDexer WebSocket client for `hip4_events` (HIP-4 on-chain actions).
 *
 * Subscribes with `{ method: 'subscribe', subscription: { type: 'hip4_events' } }`.
 */
export class HypeDexerHip4EventsWSClient extends BaseWebSocketService {
  private static instance: HypeDexerHip4EventsWSClient;

  private static readonly WS_URL = process.env.HYPEDEXER_WS_URL || 'wss://api.hypedexer.com/ws';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  private isSubscribed = false;
  private hip4Callbacks: Set<Hip4EventCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerHip4EventsWSClient.WS_URL,
        headers: {
          'X-API-Key': HypeDexerHip4EventsWSClient.API_KEY,
        },
        reconnect: true,
        reconnectInterval: 5000,
        reconnectMaxInterval: 60000,
        /** 0 = unlimited — HIP-4 upstream must stay up without silent stop after N failures */
        reconnectMaxAttempts: 0,
        pingInterval: 30000,
        pingTimeout: 10000,
      },
      {
        onStateChange: (state: WSConnectionState) => {
          logDeduplicator.info('HypeDexerHip4EventsWSClient: State changed', { state });
        },
      }
    );

    if (!HypeDexerHip4EventsWSClient.API_KEY) {
      logDeduplicator.warn('HypeDexerHip4EventsWSClient: No HL_INDEXER_API_KEY set — upstream may reject');
    }
    logDeduplicator.info('HypeDexerHip4EventsWSClient: Initialized', {
      url: HypeDexerHip4EventsWSClient.WS_URL,
      hasApiKey: !!HypeDexerHip4EventsWSClient.API_KEY,
    });
  }

  public static getInstance(): HypeDexerHip4EventsWSClient {
    if (!HypeDexerHip4EventsWSClient.instance) {
      HypeDexerHip4EventsWSClient.instance = new HypeDexerHip4EventsWSClient();
    }
    return HypeDexerHip4EventsWSClient.instance;
  }

  public start(): void {
    this.connect();
  }

  public stop(): void {
    this.unsubscribe();
    this.disconnect();
    this.hip4Callbacks.clear();
  }

  /**
   * Register for HIP-4 events. Returns unsubscribe.
   */
  public onHip4Event(callback: Hip4EventCallback): () => void {
    this.hip4Callbacks.add(callback);
    return () => {
      this.hip4Callbacks.delete(callback);
    };
  }

  public subscribe(): void {
    const message = {
      method: 'subscribe' as const,
      subscription: {
        type: 'hip4_events' as const,
      },
    };
    const sent = this.send(message);
    if (sent) {
      logDeduplicator.info('HypeDexerHip4EventsWSClient: Subscription sent (hip4_events)');
    }
  }

  public unsubscribe(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const ok = this.send({
        method: 'unsubscribe',
        subscription: {
          type: 'hip4_events',
        },
      });
      logDeduplicator.info('HypeDexerHip4EventsWSClient: Unsubscribe sent (hip4_events)', {
        sent: ok,
        wasSubscribed: this.isSubscribed,
      });
    } else {
      logDeduplicator.warn('HypeDexerHip4EventsWSClient: Unsubscribe skipped (socket not open)');
    }
    this.isSubscribed = false;
  }

  protected onOpen(): void {
    logDeduplicator.info('HypeDexerHip4EventsWSClient: Connection opened');
    this.subscribe();
  }

  protected onMessage(data: unknown): void {
    try {
      const event = data as { type?: string };

      switch (event.type) {
        case 'hip4_events':
          this.handleHip4Events(event as HypeDexerHip4EventsMessage);
          break;

        case 'subscription_confirmed':
        case 'subscription_added':
          this.isSubscribed = true;
          logDeduplicator.info('HypeDexerHip4EventsWSClient: Subscription confirmed', {
            type: event.type,
          });
          break;

        case 'error':
          logDeduplicator.error('HypeDexerHip4EventsWSClient: Server error', {
            message: (event as { message?: string }).message,
            code: (event as { code?: string }).code,
          });
          break;

        case 'welcome':
          logDeduplicator.info('HypeDexerHip4EventsWSClient: Welcome received');
          break;

        case 'ping':
          this.send({ type: 'pong', ts: (event as { ts?: number }).ts ?? Date.now() });
          break;

        default:
          logDeduplicator.debug('HypeDexerHip4EventsWSClient: Ignored message type', {
            type: event.type,
          });
      }
    } catch (error) {
      logDeduplicator.error('HypeDexerHip4EventsWSClient: Message handling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleHip4Events(message: HypeDexerHip4EventsMessage): void {
    const raw = message.data as unknown;
    const payloads: Hip4EventPayload[] = Array.isArray(raw)
      ? (raw as Hip4EventPayload[])
      : raw && typeof raw === 'object'
        ? [raw as Hip4EventPayload]
        : [];

    void this.runHip4CallbacksSequential(message, payloads);
  }

  /**
   * Await async dispatchers so HIP-4 Telegram batches don't overlap unbounded.
   */
  private async runHip4CallbacksSequential(
    message: HypeDexerHip4EventsMessage,
    payloads: Hip4EventPayload[]
  ): Promise<void> {
    for (const payload of payloads) {
      if (!payload || !Array.isArray(payload.keywords)) {
        logDeduplicator.warn('HypeDexerHip4EventsWSClient: Skipping invalid hip4_events item');
        continue;
      }

      logDeduplicator.info('HypeDexerHip4EventsWSClient: Received hip4_events', {
        count: message.count,
        keywords: payload.keywords,
        dedupePreview: buildHip4EventDedupeKey(payload).slice(0, 16),
      });

      for (const callback of this.hip4Callbacks) {
        try {
          await Promise.resolve(callback(payload));
        } catch (error) {
          logDeduplicator.error('HypeDexerHip4EventsWSClient: Callback error', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
