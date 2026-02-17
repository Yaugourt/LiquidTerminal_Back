import { LiquidationResponse, LiquidationQueryParams } from './liquidations.types';

/**
 * Interface to break circular dependency between SSE Manager and Liquidations Service.
 * SSEManagerService depends on this interface (not the concrete LiquidationsService).
 * LiquidationsService implements this and registers itself via setDataProvider().
 */
export interface LiquidationDataProvider {
  getRecentLiquidations(params?: LiquidationQueryParams): Promise<LiquidationResponse>;
}
