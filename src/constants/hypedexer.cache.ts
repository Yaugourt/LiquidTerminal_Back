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
  globalSnapshot:        300,   // daily-pnl-10d, daily-volume-10d
  globalRolling:          55,   // fenêtres glissantes 24h
  staticList:            120,   // dexs, assets (quasi-statiques)
  userAddress:            30,   // données user-spécifiques
  buildersAllTimeframes:  55,   // 55s — très lent chez HypeDexer
  buildersStats:          30,   // 30s — données actives
  buildersTop:            30,   // 30s — données actives
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
  // HIP4 — globaux
  hip4Markets:              'hypedexer:hip4:markets',
  hip4Questions:            'hypedexer:hip4:questions',
  hip4OutcomeTokens:        'hypedexer:hip4:outcome-tokens',
  hip4FeeScales:            'hypedexer:hip4:fee-scales',
} as const;

/** Clés de cache pour les endpoints builders — combinaisons timeframe/sort */
export const HYPEDEXER_BUILDERS_CACHE_KEY = {
  statsAllTimeframes: 'hypedexer:builders:stats:all-timeframes',
  stats: (timeframe: string) => `hypedexer:builders:stats:${timeframe}`,
  top:   (timeframe: string, sort: string) => `hypedexer:builders:top:${timeframe}:${sort}`,
} as const;

/** Clés de cache par adresse utilisateur — fonctions génératrices */
export const HYPEDEXER_USER_CACHE_KEY = {
  overview:         (addr: string) => `hypedexer:user:${addr}:overview`,
  coins:            (addr: string) => `hypedexer:user:${addr}:coins`,
  performance:      (addr: string) => `hypedexer:user:${addr}:performance`,
  fills:            (addr: string) => `hypedexer:user:${addr}:fills`,
  spotFills:        (addr: string) => `hypedexer:user:${addr}:spot-fills`,
  userFunding:      (addr: string) => `hypedexer:user:${addr}:funding`,
  coinDistribution: (addr: string) => `hypedexer:user:${addr}:coin-distribution`,
  vaultEquities:    (addr: string) => `hypedexer:user:${addr}:vault-equities`,
  twaps:            (addr: string) => `hypedexer:user:${addr}:twaps`,
  hip3Overview:     (addr: string) => `hypedexer:hip3:user:${addr}:overview`,
  hip3Coins:        (addr: string) => `hypedexer:hip3:user:${addr}:coins`,
  hip3Fills:        (addr: string) => `hypedexer:hip3:user:${addr}:fills`,
  hip4Fills:        (addr: string) => `hypedexer:hip4:user:${addr}:fills`,
  hip4Fees:         (addr: string) => `hypedexer:hip4:user:${addr}:fees`,
  hip4UserActions:  (addr: string) => `hypedexer:hip4:user:${addr}:actions`,
} as const;
