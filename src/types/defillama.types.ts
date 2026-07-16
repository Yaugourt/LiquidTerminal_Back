/**
 * DefiLlama free API response shapes (subset consumed by LiquidTerminal project pages).
 * Upstream returns many more fields; we type only what the project pages use and keep
 * the rest permissive so a DefiLlama schema change does not break our proxy.
 */

/** Item from `GET /protocols`. */
export interface DefiLlamaProtocolListItem {
  id: string;
  name: string;
  slug?: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  logo: string | null;
  url: string | null;
  tvl: number | null;
  change_1d: number | null;
  change_7d: number | null;
  mcap: number | null;
  /** Per-chain TVL map, includes `-borrowed`/`-staking` variants (e.g. "Hyperliquid L1-borrowed"). */
  chainTvls?: Record<string, number>;
  /** `parent#<slug>` marker when the protocol is a child of a parent protocol. */
  parentProtocol?: string | null;
  /** Bare parent slug (same info as parentProtocol without the prefix). */
  parentProtocolSlug?: string | null;
}

/** Protocol entry of `GET /overview/fees/{chain}` and `/overview/dexs/{chain}`. */
export interface DefiLlamaChainOverviewProtocol {
  name: string;
  slug?: string;
  displayName?: string;
  category: string | null;
  total24h: number | null;
  parentProtocol?: string | null;
}

/** Response of `GET /overview/{fees|dexs}/{chain}` with charts excluded. */
export interface DefiLlamaChainOverview {
  chain?: string;
  total24h: number | null;
  protocols: DefiLlamaChainOverviewProtocol[];
  [key: string]: unknown;
}

/** Single point of a historical TVL series. */
export interface DefiLlamaTvlPoint {
  date: number;
  totalLiquidityUSD: number;
}

/** Per-chain TVL breakdown from `GET /protocol/{slug}`. */
export interface DefiLlamaChainTvl {
  tvl?: DefiLlamaTvlPoint[];
  tokens?: unknown;
  tokensInUsd?: unknown;
}

/** Response of `GET /protocol/{slug}` (details + historical TVL). */
export interface DefiLlamaProtocolDetail {
  id: string;
  name: string;
  symbol: string | null;
  url: string | null;
  description: string | null;
  logo: string | null;
  gecko_id: string | null;
  cmcId: string | null;
  category: string | null;
  chains: string[];
  twitter: string | null;
  github?: string[] | null;
  address: string | null;
  currentChainTvls: Record<string, number>;
  chainTvls: Record<string, DefiLlamaChainTvl>;
  tvl?: DefiLlamaTvlPoint[];
  mcap: number | null;
  [key: string]: unknown;
}

/** Item from `GET /v2/chains`. */
export interface DefiLlamaChain {
  gecko_id: string | null;
  tvl: number;
  tokenSymbol: string | null;
  cmcId: string | null;
  name: string;
  chainId: number | null;
}

/** Response of `GET /summary/dexs/{slug}` and `GET /summary/fees/{slug}` (shared shape). */
export interface DefiLlamaSummary {
  name: string;
  total24h: number | null;
  total48hto24h: number | null;
  total7d: number | null;
  total30d: number | null;
  totalAllTime: number | null;
  change_1d: number | null;
  chains: string[];
  [key: string]: unknown;
}

/** Current price entry from `GET /prices/current/{coins}`. */
export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
  decimals?: number;
}

/** Response of `GET /prices/current/{coins}`. */
export interface DefiLlamaPrices {
  coins: Record<string, DefiLlamaCoinPrice>;
}

/** Compact fees/revenue block used inside the aggregate overview. */
export interface DefiLlamaMoneyBlock {
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  totalAllTime: number | null;
  change_1d: number | null;
}

/**
 * Aggregated per-project snapshot for a project page. Every enrichment field is
 * nullable: a protocol may have TVL but no DEX/fees module, or vice versa.
 */
export interface DefiLlamaProjectOverview {
  slug: string;
  name: string;
  logo: string | null;
  category: string | null;
  chains: string[];
  gecko_id: string | null;
  tvl: number | null;
  mcap: number | null;
  currentChainTvls: Record<string, number> | null;
  price: DefiLlamaCoinPrice | null;
  volume: DefiLlamaMoneyBlock | null;
  fees: DefiLlamaMoneyBlock | null;
  revenue: DefiLlamaMoneyBlock | null;
}
