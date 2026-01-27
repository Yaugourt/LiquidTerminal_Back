import { Response } from 'express';
import { Liquidation } from './liquidations.types';

/**
 * SSE client connection with filter preferences
 */
export interface SSEClient {
  id: string;                          // Unique connection ID (UUID)
  res: Response;                       // Express Response object
  filters: SSEClientFilters;           // Client's filter preferences
  connectedAt: number;                 // Connection timestamp
  lastEventId: number | null;          // Last sent tid (for resume)
  ip: string;                          // Client IP for rate limiting
}

/**
 * Filter options for SSE subscriptions
 */
export interface SSEClientFilters {
  coin?: string;                       // Filter by coin (e.g., "BTC", "ETH")
  minAmountDollars?: number;           // Minimum notional value filter
  user?: string;                       // Filter by liquidated wallet address
}

/**
 * SSE event data structure
 */
export interface SSELiquidationEvent {
  type: 'liquidation' | 'heartbeat' | 'connected' | 'error';
  data: Liquidation | Liquidation[] | null;
  id?: number;                         // Event ID (tid for liquidations)
  timestamp: string;                   // ISO timestamp
}

/**
 * Redis pub/sub message for cross-instance communication
 */
export interface SSEBroadcastMessage {
  newLiquidations: Liquidation[];
  timestamp: string;
}

/**
 * SSE connection statistics
 */
export interface SSEConnectionStats {
  totalConnections: number;
  uniqueIps: number;
}
