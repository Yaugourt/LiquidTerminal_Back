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

/**
 * TTLs (seconds). Heavy /fills/* = on-demand by default; use short TTL only for hot keys.
 *
 * Every key is shared by all visitors (or by every viewer of one wallet), so
 * the upstream cost of a TTL is per key, not per visitor. Keys of 30 s or
 * less are live data: once expired, one refresh runs and readers wait for it
 * at most 1.5 s before cacheService serves their last copy (nobody waits
 * longer for HypeDexer), and every key falls back to its last copy when a
 * refresh fails.
 */
export const HYPEDEXER_TTL = {
  fillsCount:             30,   // existant
  overviewSlice:          55,   // existant
  /** daily-volume-10d: its last bar is today's running total (~3 credits a read). */
  globalSnapshot:         30,
  /** daily-pnl-10d: ~3 250 rows (~330 credits) of daily buckets per coin. */
  dailyPnl10d:          3600,
  globalRolling:          55,   // fenêtres glissantes 24h (predicted fundings: read every 5 min)
  /** Dashboard 24h volume, fees, fills, active traders; HIP-3 overview and top movers (~3 credits each). */
  liveRolling:            15,
  staticList:            120,   // dexs, assets (quasi-statiques)
  userAddress:            30,   // données user-spécifiques (overview, coins…)
  /** A wallet's fills (perp, spot, HIP-3, HIP-4): billed per wallet viewed, not per viewer. */
  userFills:              15,
  /** Funding is paid once an hour, and the summary reads up to 5 000 events
   * (~500 credits): recomputing it every 30 s changed nothing but the bill. */
  userFundingSummary:   1800,
  buildersAllTimeframes:  55,   // 55s — très lent chez HypeDexer
  /** Global builder stats per timeframe, and one builder's stats and users
   * (keyed per builder, timeframe and limit): the pages poll every 15 s (3 credits). */
  buildersStats:          15,
  /** Polled every 15 s by /market/builders, the hub lanes and the dashboard
   * cards (one shared key per limit 3, 5, 100; ~3 credits each). */
  buildersTop:            15,
  hip4Analytics:          60,   // analytics bucketed — 1h buckets change every hour
  /** Other filtered analytics (outcome splits, date ranges). */
  hip4AnalyticsFiltered:  60,
  /** The live-market volume fan-out: daily buckets of coin chunks, no date
   * range, the same ~11-17 chunks for everyone (~17 × 7 credits each refresh,
   * ~476 a minute while anyone views the HIP-4 pages). Also the TTL of the
   * aggregate (`HYPEDEXER_HIP4_CACHE_KEY.liveVolumes`) the pages poll every 15 s. */
  hip4LiveVolumes:        15,
  /** Hyperliquid `outcomeMeta`, read for its outcome ids only (they change when
   * an outcome is created); free, but 20 HL weight a read. */
  hip4OutcomeMeta:        60,
  /** Market fills (a coin's tape, the global tape), by age of the newest fill:
   * a market trading in the last hour, one quiet for hours, one dormant for a
   * day or more (settled/expired: its history no longer moves). The tapes
   * poll every 10 s. */
  hip4ActiveFills:        10,
  hip4QuietFills:         60,
  hip4DormantFills:     3600,
  /** A dormant coin tape whose market Hyperliquid no longer lists
   * (outcomeMeta): it cannot trade again, so its history (up to 1,000 fills,
   * ~102 credits a read) is kept a day. */
  hip4DelistedFills:   86400,
  /** HIP-4 metadata lists (markets, outcome tokens, questions) read by the
   * enriched endpoints and settlements; an empty answer is retried sooner. */
  hip4BaseList:          600,
  hip4BaseListRetry:      60,
  /** Enriched settlements (new rows only when a market settles), the list page's poll. */
  hip4Settlements:        30,
  /** One market's row, read for a deep link or a settlement outside the
   * lists: a settled market no longer changes; an open one is re-read for
   * its volume and settlement. */
  hip4SettledMarket:   86400,
  hip4OpenMarket:        300,
  /** How the markets that no longer trade ended (`getResolutions`): the
   * aggregate is recomputed at most hourly, from the per-market reads below,
   * and kept 30 days so only a cold start waits for it. */
  hip4Resolutions:      3600,
  hip4ResolutionsKeep: 2592000,
  /** A delisted market's last trades (10 fills, 3 credits) and a settled
   * market's settlement (3 credits): neither changes again, so they are kept
   * a week. Trades younger than a day keep the dormant hour, an empty
   * settlement answer the settled-market day. */
  hip4FinalReads:     604800,
  /** Hyperliquid's HIP-4 template registry (not HypeDexer, free): a template
   * added upstream titles its markets within the hour. */
  hip4OutcomeTemplates: 3600,
  /** HIP-3 market pages: the tape (polled every 10 s), cumulative snapshots
   * (polled every 10-15 s) and per-market trader aggregates (60 s). */
  hip3Fills:              10,
  hip3Snapshots:          15,
  hip3StatsTraders:      120,
  /** Market-wide live lists: completed trades (biggest trades, trade
   * explorer, a wallet's round trips) and their summary, TWAP flow,
   * fills/priority-fee stats (~7-17 credits a call, shared). */
  marketList:             15,
  /** /indexer/twaps pages of 500 (~52 credits each): the front's primary TWAP
   * source. Every page carries live progress, and pages walked together must
   * come from close snapshots (a row crossing a page boundary between two
   * refreshes is missing from the walk), so all pages share one TTL. */
  twapSourcePages:        10,
  /** The TWAP source aggregate (`HYPEDEXER_TWAPS_CACHE_KEY.source`): the front
   * polls it every 15 s, and each refresh re-reads the first page of both
   * queries (2 × ~52 credits, ~420 a minute while anyone views). */
  twapSource:             15,
  /** The deeper pages (offset > 0) of one source query: older, slower-moving
   * rows, walked once a minute for every visitor (~6 pages of ~52 credits for
   * the 24 h query). Their last copy is served while a walk runs or fails. */
  twapSourceDeep:         60,
  /** Enriched markets/questions: the payload carries live mid_price odds
   * from HL allMids. A recompute costs no credits (the lists are cached). */
  hip4EnrichedList:       15,
  evmStats:               15,   // EVM global stats (the explorer polls every 15 s)
  evmStatsDaily:         300,   // EVM daily stats (slow-changing)
  evmBlocks:               5,   // EVM blocks (fast-changing)
  /** Blocks with params (the explorer polls `limit=20` every 5 s): one shared call every 5 s. */
  evmBlocksPage:           5,
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
  /** One builder's page (address lowercased; `default` when the param is left to upstream). */
  builderStats: (address: string, timeframe: string) =>
    `hypedexer:builders:${address.toLowerCase()}:stats:${timeframe}`,
  builderUsers: (address: string, timeframe: string, limit: string) =>
    `hypedexer:builders:${address.toLowerCase()}:users:${timeframe}:${limit}`,
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
  /** Outcome ids from Hyperliquid `outcomeMeta` (the live-volumes coin list). */
  outcomeIds: 'hyperliquid:hip4:outcome-ids',
  /** Every live outcome side's volume in one entry: the HIP-4 pages' poll. */
  liveVolumes: 'hypedexer:hip4:live-volumes',
  /** How the list's markets that no longer trade ended, in one entry. */
  resolutions: 'hypedexer:hip4:resolutions',
} as const;

/** TWAP source keys (indexer-twaps.service.ts); the pages themselves use buildHypedexerCacheKey. */
export const HYPEDEXER_TWAPS_CACHE_KEY = {
  /** Both source queries merged, the front's poll. */
  source: 'hypedexer:twaps:source',
  /** Deep pages (offset > 0) of one source query, by query name. */
  sourceDeep: (query: string) => `hypedexer:twaps:source-deep:${query}`,
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
