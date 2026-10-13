/**
 * Redis keys, pub/sub channels, and distributed lock names for HypeDexer (HL Indexer) REST integrations.
 * Prefer one channel per **domain** refresh (batch publish after multi-key SET), not per endpoint.
 *
 * Polling clients under `hypedexer/rest/` may use legacy Redis keys (e.g. `builders:all`); optional migration under `hypedexer:` prefix is separate.
 */

/** Prefix for new indexer-backed cache keys (optional migration from legacy keys). */
export const HYPEDEXER_CACHE_PREFIX = 'hypedexer' as const;

/** Pub/sub: one channel per domain when background polling refreshes multiple keys. */
export const HYPEDEXER_CHANNELS = {
  fills: `${HYPEDEXER_CACHE_PREFIX}:fills:updated`,
  users: `${HYPEDEXER_CACHE_PREFIX}:users:updated`,
  overview: `${HYPEDEXER_CACHE_PREFIX}:overview:updated`,
  hip3: `${HYPEDEXER_CACHE_PREFIX}:hip3:updated`,
  analytics: `${HYPEDEXER_CACHE_PREFIX}:analytics:updated`,
  builders: `${HYPEDEXER_CACHE_PREFIX}:builders:updated`,
} as const;

/** Distributed locks for pollers (seconds TTL typical: 90). */
export const HYPEDEXER_LOCKS = {
  pollFills: 'poll:hypedexer:fills',
  pollOverview: 'poll:hypedexer:overview',
  pollHip3: 'poll:hypedexer:hip3',
} as const;

/** Example TTLs (seconds). Heavy /fills/* = on-demand by default; use short TTL only for hot keys. */
export const HYPEDEXER_TTL = {
  fillsCount:             30,   // existant
  overviewSlice:          55,   // existant
  globalSnapshot:        300,   // daily-volume-10d
  /** daily-pnl-10d: ~3 250 rows (~330 credits) of daily buckets per coin. */
  dailyPnl10d:          3600,
  globalRolling:          55,   // fenêtres glissantes 24h
  staticList:            120,   // dexs, assets (quasi-statiques)
  userAddress:            30,   // données user-spécifiques
  /** Funding is paid once an hour, and the summary reads up to 5 000 events
   * (~500 credits): recomputing it every 30 s changed nothing but the bill. */
  userFundingSummary:   1800,
  buildersAllTimeframes:  55,   // 55s — très lent chez HypeDexer
  buildersStats:          30,   // 30s — données actives
  buildersTop:            60,   // polled every 30 s by three pages (limits 3, 5, 100)
  hip4Analytics:          60,   // analytics bucketed — 1h buckets change every hour
  /** Coin-filtered analytics: the live-market volume fan-out asks ~11 chunks
   * of daily buckets per visitor every 5 min, the same chunks for everyone. */
  hip4AnalyticsFiltered: 300,
  /** Market fills (a coin's tape, the global tape), by age of the newest fill:
   * a market trading in the last hour, one quiet for hours, one dormant for a
   * day or more (settled/expired: its history no longer moves). */
  hip4ActiveFills:        15,
  hip4QuietFills:         60,
  hip4DormantFills:     3600,
  /** HIP-4 metadata lists (markets, outcome tokens, questions) read by the
   * enriched endpoints and settlements; an empty answer is retried sooner. */
  hip4BaseList:          600,
  hip4BaseListRetry:      60,
  /** Enriched settlements (new rows only when a market settles). */
  hip4Settlements:        60,
  /** One market's row, read for a deep link or a settlement outside the
   * lists: a settled market no longer changes; an open one is re-read for
   * its volume and settlement. */
  hip4SettledMarket:   86400,
  hip4OpenMarket:        300,
  /** Hyperliquid's HIP-4 template registry (not HypeDexer, free): a template
   * added upstream titles its markets within the hour. */
  hip4OutcomeTemplates: 3600,
  /** HIP-3 market pages: the tape (polled every 10 s), cumulative snapshots
   * (30 s) and per-market trader aggregates (60 s). */
  hip3Fills:              15,
  hip3Snapshots:          60,
  hip3StatsTraders:      120,
  /** Market-wide lists polled every minute or more: completed trades (biggest
   * trades, trade explorer, a wallet's round trips) and their summary, TWAP
   * flow, fills/priority-fee stats. */
  marketList:             60,
  /** /indexer/twaps pages of 500: the front's primary TWAP source, polled every 30 s. */
  twapSourcePages:        20,
  /** Enriched markets/questions cache. Lower than `staticList` because the
   * payload includes live mid_price overlays from HL allMids — 2 min is too
   * stale for prediction-market probabilities. */
  hip4EnrichedList:       30,
  evmStats:               30,   // EVM global stats
  evmStatsDaily:         300,   // EVM daily stats (slow-changing)
  evmBlocks:               5,   // EVM blocks (fast-changing)
  /** Blocks with params (the explorer polls `limit=20` every 15 s). */
  evmBlocksPage:          15,
  evmTransactions:         5,   // EVM transactions (fast-changing)
  evmBridgeEvents:        30,   // EVM bridge events
  evmLedgerTransfers:     30,   // EVM ledger transfers
  /** Elysium testnet pass-through (keys built with buildHypedexerCacheKey, params included). */
  elysiumStats:           15,
  elysiumStatsDaily:     300,
  elysiumBlocks:           5,
  elysiumTransactions:     5,
  elysiumBatches:         60,
  elysiumBridgeTransfers: 10,
  elysiumBridgeRetryables: 60,
  elysiumBridgeReserves: 120,
  elysiumBridgeTokens:   300,
  elysiumTokens:         300,
  elysiumUser:            15,
  /** Vault leaderboards — heavy fan-out aggregation across top-N candidates;
   * keep at 5 min to amortize the per-vault snapshot/ledger calls. */
  vaultLeaderboards:     300,
  /** Vault list: `limit=5000` costs ~500 credits, and followers move slowly. */
  vaultSummaries:        300,
  /** Vault metadata + portfolio history. */
  vaultDetails:          300,
  /** ~hourly equity snapshots. */
  vaultEquitySnapshots:  300,
  /** One snapshot per vault per day. */
  vaultDailySnapshots:  1800,
  vaultLedger:            60,
  /** `/vaults/vaultLedger` answers [] even for HLP (2026-09): keep an empty
   * answer for an hour instead of asking again on every poll. */
  vaultLedgerEmpty:     3600,
} as const;

/** Clés de cache pour les endpoints globaux (identiques pour tous les users) */
export const HYPEDEXER_CACHE_KEYS = {
  // Overview — globaux
  overviewActiveTraders24h: 'hypedexer:overview:active-traders-24h',
  overviewDailyPnl10d:      'hypedexer:overview:daily-pnl-10d',
  overviewDailyVolume10d:   'hypedexer:overview:daily-volume-10d',
  overviewTotalFees24h:     'hypedexer:overview:total-fees-24h',
  overviewTotalFills24h:    'hypedexer:overview:total-fills-24h',
  overviewTradingVolume24h: 'hypedexer:overview:trading-volume-24h',
  // Funding — global
  fundingPredicted:         'hypedexer:funding:predicted',
  // HIP3 — globaux
  hip3Overview:             'hypedexer:hip3:overview',
  hip3TopMovers:            'hypedexer:hip3:top-movers',
  hip3Dexs:                 'hypedexer:hip3:dexs',
  hip3Assets:               'hypedexer:hip3:assets',
  hip3AuctionCurrent:       'hypedexer:hip3:auction-current',
  // HIP4 — keyed per param set in indexer-hip4.service.ts (buildHypedexerCacheKey)
  // EVM
  evmStats:             'hypedexer:evm:stats',
  evmStatsDaily:        'hypedexer:evm:stats:daily',
  evmBlocks:            'hypedexer:evm:blocks',
  evmTransactions:      'hypedexer:evm:transactions',
  // Bridge events / ledger transfers: keyed per param set in indexer-evm.service.ts
  /** Single precomputed payload shared by both leaderboard endpoints — keyed by window. */
  vaultLeaderboards:    (window: string) => `hypedexer:vaults:leaderboards:${window}`,
} as const;

/** Clés de cache pour les endpoints builders — combinaisons timeframe/sort */
export const HYPEDEXER_BUILDERS_CACHE_KEY = {
  statsAllTimeframes: 'hypedexer:builders:stats:all-timeframes',
  stats: (timeframe: string) => `hypedexer:builders:stats:${timeframe}`,
  top:   (timeframe: string, sort: string, limit: number) => `hypedexer:builders:top:${timeframe}:${sort}:${limit}`,
} as const;

/** Clés de cache HIP4 paramétrées — fonctions génératrices */
export const HYPEDEXER_HIP4_CACHE_KEY = {
  /** Analytics bucketed — one Redis entry per interval (and limit) when no
   * coin/date filter. The limit used to be left out: the 1h chart (168 rows)
   * and the tile (default) answered each other. */
  analytics: (interval: string, limit?: number) =>
    `hypedexer:hip4:analytics:${interval}${limit !== undefined ? `:${limit}` : ''}`,
  /** Hyperliquid `outcomeTemplates` (titles of templated markets). */
  outcomeTemplates: 'hyperliquid:hip4:outcome-templates',
} as const;

/**
 * A wallet's key plus every filter that changes the upstream answer. Keys
 * without them served the first caller's limit / coin / window to every later
 * caller for that wallet.
 */
function withFilters(base: string, filters?: object): string {
  const parts = Object.entries(filters ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? `${base}:${parts.join('&')}` : base;
}

/** Clés de cache par adresse utilisateur — fonctions génératrices */
export const HYPEDEXER_USER_CACHE_KEY = {
  overview:         (addr: string) => `hypedexer:user:${addr}:overview`,
  coins:            (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:coins`, filters),
  performance:      (addr: string) => `hypedexer:user:${addr}:performance`,
  fills:            (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:fills`, filters),
  spotFills:        (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:spot-fills`, filters),
  userFunding:      (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:funding`, filters),
  userFundingSummary: (addr: string, limit: number) => `hypedexer:user:${addr}:funding-summary:${limit}`,
  coinDistribution: (addr: string) => `hypedexer:user:${addr}:coin-distribution`,
  vaultEquities:    (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:vault-equities`, filters),
  twaps:            (addr: string, filters?: object) => withFilters(`hypedexer:user:${addr}:twaps`, filters),
  hip3Overview:     (addr: string) => `hypedexer:hip3:user:${addr}:overview`,
  hip3Coins:        (addr: string, filters?: object) => withFilters(`hypedexer:hip3:user:${addr}:coins`, filters),
  hip3Fills:        (addr: string, filters?: object) => withFilters(`hypedexer:hip3:user:${addr}:fills`, filters),
  /** HIP-4 user fills cache key. Must include every filter that changes the
   * upstream result so coin/outcome filters don't poison the unfiltered key. */
  hip4Fills: (addr: string, filters: {
    coin?: string;
    outcome_id?: number;
    limit?: number;
    offset?: number;
  } = {}) => {
    const parts = [
      `coin:${filters.coin ?? ''}`,
      `oid:${filters.outcome_id ?? ''}`,
      `lim:${filters.limit ?? ''}`,
      `off:${filters.offset ?? ''}`,
    ].join('|');
    return `hypedexer:hip4:user:${addr}:fills:${parts}`;
  },
} as const;
