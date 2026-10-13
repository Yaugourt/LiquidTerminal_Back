/**
 * Hyperfolio API response shapes (https://api.hyperfolio.xyz/docs), typed from
 * real responses captured on 2026-09-16 rather than the Swagger examples.
 *
 * Numeric values arrive as strings on the wallet endpoints (`"usdValue": "12.3"`)
 * and as numbers on `/portfolio-history` and `/yield`; the proxy passes them
 * through untouched and the frontend normalises them. Fields not needed by
 * LiquidTerminal are left out and tolerated through index-free interfaces.
 */

/** Upstream cache envelope attached to most wallet answers. */
export interface HyperfolioCacheInfo {
  lastUpdate: string;
  cacheAge: string;
  cacheAgeSeconds: number;
  source: 'cache' | 'api';
  isStale: boolean;
}

/** Hyperfolio answers HTTP 200 with a body-level `error` on bad input. */
export interface HyperfolioErrorBody {
  error: string;
  cache?: HyperfolioCacheInfo;
}

// ==================== /wallet/composition ====================

export interface HyperfolioEvmToken {
  address: string;
  balance: string;
  symbol: string;
  name: string;
  decimals: string;
  usdPrice: string;
  usdValue: string;
  image_url: string | null;
  type: string;
}

export interface HyperfolioComposition {
  tokens: HyperfolioEvmToken[];
  totalWalletValue: string;
  hypePrice: string;
}

export interface HyperfolioCompositionResponse {
  data: HyperfolioComposition;
  cache: HyperfolioCacheInfo;
}

// ==================== /positions ====================

export interface HyperfolioPositionToken {
  address: string;
  symbol: string;
  name: string;
  image_url: string | null;
  decimals: number | string;
  /** Raw or human balance depending on the protocol adapter — prefer `formattedBalance`. */
  balance: string;
  formattedBalance: string;
  usdValue: string;
}

export interface HyperfolioPositionReward {
  assetAddress: string;
  symbol: string;
  claimable: string;
  claimableUsd: string;
  paidToDate: string;
  paidToDateUsd: string;
}

export interface HyperfolioEstimatedYield {
  daily: string;
  weekly: string;
  monthly: string;
}

export interface HyperfolioPositionDetails {
  token?: HyperfolioPositionToken;
  tokens?: HyperfolioPositionToken[];
  apy?: string;
  estimatedYield?: HyperfolioEstimatedYield;
  reward?: HyperfolioPositionReward;
  tokenId?: string;
  positionType?: string;
}

export interface HyperfolioPosition {
  id: string;
  protocolId: string;
  protocolName: string;
  type: string;
  positionType: string;
  totalValueUSD: string;
  healthRatio?: number | null;
  isIsolated?: boolean;
  version?: string;
  details: HyperfolioPositionDetails;
}

export interface HyperfolioProtocolStats {
  weightedApyPercent: number | null;
  positionsWithApy: number;
  totalPositions: number;
  estimatedYield: HyperfolioEstimatedYield;
}

export interface HyperfolioProtocol {
  id: string;
  name: string;
  /** Relative (`/hyperlend.jpg`, served by HYPERFOLIO_ASSETS_URL) or absolute URL. */
  logo: string;
  url: string;
  totalValueUSD: string;
  positions: HyperfolioPosition[];
  warning?: string;
  metadata?: { partialData?: boolean; fetchDuration?: number };
  protocolStats: HyperfolioProtocolStats;
}

export interface HyperfolioPortfolioStats {
  totalValueUSD: string;
  weightedApyPercent: number | null;
  positionsWithApy: number;
  totalPositions: number;
  estimatedYield: HyperfolioEstimatedYield;
}

export interface HyperfolioPositionsData {
  protocols: HyperfolioProtocol[];
  portfolioStats: HyperfolioPortfolioStats;
}

export interface HyperfolioPositionsResponse {
  data: HyperfolioPositionsData;
  cache: HyperfolioCacheInfo;
}

/** One `data:` payload of `/positions/stream`. */
export type HyperfolioStreamEvent =
  | { type: 'protocol'; data: HyperfolioProtocol; progress: HyperfolioStreamProgress }
  | { type: 'error'; error: string; progress: HyperfolioStreamProgress }
  | { type: 'complete'; progress: HyperfolioStreamProgress; portfolioStats?: HyperfolioPortfolioStats };

export interface HyperfolioStreamProgress {
  completed: number;
  total: number;
}

// ==================== /portfolio-history ====================

export interface HyperfolioPortfolioSnapshot {
  user_address: string;
  total_value_usd: number;
  total_positions: number;
  active_protocols: number;
  token_value_usd?: number;
  defi_value_usd?: number;
  hypercore_value_usd?: number;
  nft_value_usd?: number;
  lending_value_usd?: number;
  liquidity_value_usd?: number;
  staking_value_usd?: number;
  other_value_usd?: number;
  protocols_breakdown?: Record<string, number>;
  snapshot_date: string;
  snapshot_timestamp: number;
  created_at: string;
}

export interface HyperfolioPortfolioHistorySummary {
  current_value: number;
  change_24h: number | null;
  change_7d: number | null;
  change_30d: number | null;
  percent_change_24h: number | null;
  percent_change_7d: number | null;
  percent_change_30d: number | null;
  first_snapshot: string | null;
  last_snapshot: string | null;
  total_snapshots: number;
}

export interface HyperfolioPortfolioHistoryResponse {
  snapshots: HyperfolioPortfolioSnapshot[];
  summary: HyperfolioPortfolioHistorySummary;
}

// ==================== /wallet/transactions ====================

export type HyperfolioTransactionType = 'all' | 'normal' | 'token' | 'internal';

export interface HyperfolioDecodedToken {
  address: string;
  symbol: string;
  amount: string;
  amountRaw: string;
  decimals: number;
  priceUSD: number | null;
  valueUSD: number | null;
}

export interface HyperfolioDecodedTransaction {
  method: string;
  action: string;
  protocol: { id: string; name: string; logo: string };
  direction: 'in' | 'out' | 'neutral' | string;
  tokens?: HyperfolioDecodedToken[];
  amounts?: Record<string, string>;
  addresses?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface HyperfolioTransaction {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenDecimal?: string;
  gasUsed?: string;
  gasPrice?: string;
  isError?: string;
  txreceipt_status?: string;
  functionName?: string;
  methodId?: string;
  type: 'normal' | 'token' | 'internal';
  decoded?: HyperfolioDecodedTransaction;
}

export interface HyperfolioTransactionsResponse {
  transactions: HyperfolioTransaction[];
  page: number;
  offset: number;
  total: number;
  hasMore: boolean;
  filters: Record<string, string>;
}

export interface HyperfolioTransactionsQuery {
  page?: number;
  offset?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  type?: HyperfolioTransactionType;
}

// ==================== /nfts ====================

export interface HyperfolioNft {
  address: string;
  name: string;
  symbol: string;
  collection_name: string;
  tokenId?: string;
  image?: string | null;
  image_url?: string | null;
  price?: number | string | null;
  floorPrice?: number | string | null;
  floor_price?: number | string | null;
  lastSalePrice?: number | string | null;
  [key: string]: unknown;
}

export interface HyperfolioNftsPagination {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface HyperfolioNftsResponse {
  data: {
    nfts: HyperfolioNft[];
    pagination: HyperfolioNftsPagination;
    totalNftValue: number;
    whypeUsdPrice: number;
  };
  cache: HyperfolioCacheInfo;
}

export interface HyperfolioNftsQuery {
  page?: number;
  limit?: number;
  collection?: string;
}

// ==================== /points ====================

export interface HyperfolioProtocolPoints {
  protocolName: string;
  points: number;
}

export interface HyperfolioPointsResponse {
  data: HyperfolioProtocolPoints[];
  cache: HyperfolioCacheInfo;
}

// ==================== /yield ====================

export type HyperfolioYieldCategory = 'lending' | 'amm' | 'yield' | 'staking' | 'derivatives';
export type HyperfolioYieldType = 'supply' | 'borrow' | 'lp' | 'stake' | 'pt' | 'yt' | 'vault';
export type HyperfolioRiskLevel = 'low' | 'medium' | 'high';

export interface HyperfolioYieldTokenDetails {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface HyperfolioYieldOpportunity {
  id: string;
  protocol: {
    id: string;
    name: string;
    category: string;
    website?: string;
    chainId?: number;
  };
  category: HyperfolioYieldCategory;
  type: HyperfolioYieldType;
  pool: {
    address: string;
    name: string;
    symbol?: string;
    /** Missing on lending markets (Felix, Hyperlend, Hypurrfi). */
    tvlUsd?: number;
    token0?: HyperfolioYieldTokenDetails;
    token1?: HyperfolioYieldTokenDetails;
    underlyingToken?: HyperfolioYieldTokenDetails;
  };
  apy: {
    baseApy: number;
    totalApy: number;
    rewardApy?: number;
    available?: boolean;
    historical?: { apy1d?: number; apy7d?: number; apy30d?: number };
  };
  risk: {
    riskLevel: HyperfolioRiskLevel;
    impermanentLossRisk?: boolean;
    liquidationRisk?: boolean;
  };
  metadata: {
    underlyingToken?: string;
    underlyingSymbol?: string;
    protocolSpecific?: Record<string, unknown>;
  };
  lastUpdated: string;
  dataSource: 'on-chain' | 'api' | 'hybrid';
}

export interface HyperfolioYieldFilterOption {
  value: string;
  count: number;
  label: string;
}

export interface HyperfolioYieldResponse {
  data: HyperfolioYieldOpportunity[];
  pagination: {
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
    next: string | null;
    prev: string | null;
  };
  metadata: {
    filters: {
      categories: HyperfolioYieldFilterOption[];
      protocols: HyperfolioYieldFilterOption[];
      tokenAddresses?: HyperfolioYieldFilterOption[];
    };
    totals: {
      total_value_usd: number;
      total_apy: number;
      opportunity_count: number;
    };
    /** Set by this backend when `totals.total_value_usd` is absurd (spam pools priced with fake prices). */
    totals_untrusted?: boolean;
  };
}

export interface HyperfolioYieldQuery {
  page?: number;
  page_size?: number;
  search?: string;
  categories?: string[];
  protocols?: string[];
  token_addresses?: string[];
  token_symbols?: string[];
  min_apy?: number;
  max_apy?: number;
  min_tvl?: number;
  max_tvl?: number;
  sort_by?: 'apy' | 'tvl' | 'name';
  sort_order?: 'asc' | 'desc';
}
