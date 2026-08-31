import { AggregatePositioningClient } from '../../clients/hyperliquid/positioning/aggregate-positioning.client';
import { AggregatePositioningResponse, PositioningError } from '../../types/positioning.types';

/**
 * Thin service over the aggregate positioning poller: reads the cached snapshot
 * and wraps it in the standard response envelope. All the heavy fan-out and
 * caching live in the client.
 */
export class AggregatePositioningService {
  private static instance: AggregatePositioningService;
  private readonly client: AggregatePositioningClient;

  private constructor() {
    this.client = AggregatePositioningClient.getInstance();
  }

  public static getInstance(): AggregatePositioningService {
    if (!AggregatePositioningService.instance) {
      AggregatePositioningService.instance = new AggregatePositioningService();
    }
    return AggregatePositioningService.instance;
  }

  public async getPositioning(): Promise<AggregatePositioningResponse> {
    try {
      const data = await this.client.getPositioning();
      return {
        success: true,
        data,
        metadata: { cachedAt: new Date().toISOString() },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
        throw new PositioningError('Upstream rate limit', 429, 'RATE_LIMIT_EXCEEDED');
      }
      throw new PositioningError(message);
    }
  }
}
