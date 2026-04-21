/**
 * HypeDexer WebSocket — HIP-4 outcome / market events (`hip4_events` subscription).
 * @see HypeDexerHip4EventsWSClient
 */

/**
 * Single HIP-4 event payload from HypeDexer (shape aligned with indexer line + metadata).
 */
export interface Hip4EventPayload {
  keywords: string[];
  block_time?: string;
  block_height?: number;
  detected_at?: string;
  /** Full JSON line from replica / source (stringified object or raw line). */
  raw?: string;
  /** Transaction hash when indexer sends it (0x…). */
  tx_hash?: string;
  /** Alias some payloads use for the same hash. */
  hash?: string;
}

/**
 * Server → client message for `type: 'hip4_events'`.
 */
export interface HypeDexerHip4EventsMessage {
  type: 'hip4_events';
  count: number;
  /** Single event or batch (normalized by client). */
  data: Hip4EventPayload | Hip4EventPayload[];
}

/** May be async so upstream can await dispatch (no overlapping unhandled rejections). */
export type Hip4EventCallback = (event: Hip4EventPayload) => void | Promise<void>;
