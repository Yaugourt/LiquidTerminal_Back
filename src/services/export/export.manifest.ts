import { EXPORT_MAX_ROWS } from '../../constants/export.constants';

/**
 * The catalog of exportable datasets.
 *
 * One entry per list endpoint worth downloading. Columns are deliberately NOT
 * declared here: they are discovered from the first page of the response, so a
 * field added upstream shows up in the export without a code change, and no
 * hand-written column list can silently drift from reality.
 */

export type ExportParamType = 'datetime' | 'string' | 'number' | 'enum' | 'address';

export interface ExportParamSpec {
  /** Query key sent upstream. */
  key: string;
  label: string;
  type: ExportParamType;
  /** Allowed values for `enum`. */
  options?: string[];
  placeholder?: string;
  help?: string;
  /** Upstream rejects the call without it; the UI must block the export. */
  required?: boolean;
}

export type ExportPagination = 'cursor' | 'offset' | 'none';
/**
 * Every list endpoint here is walked by offset, not cursor, even though several
 * hand out a `next_cursor`. Measured on /fills 2026-07-26: the first page takes
 * ~5s, its cursor page ~45s (past the 30s client timeout), while offset pages
 * come back in 1-3s with zero overlap between them. Cursor would be the safer
 * semantics on a live feed, so the service pins `end_time` instead — see
 * ExportService.freezeWindow.
 */

/**
 * Where the rows come from. `hypedexer` walks the provider's REST API directly;
 * `local` calls this backend's own services, which is how the tables the app
 * actually renders (spot, perp, vaults, validators, projects, wiki) become
 * exportable at all.
 */
export type ExportSource = 'hypedexer' | 'local';

export interface ExportDataset {
  id: string;
  label: string;
  group: 'Trading' | 'Chain' | 'Markets' | 'Capital' | 'Ecosystem';
  description: string;
  source: ExportSource;
  /** HypeDexer path. Empty for `local` datasets, whose resolver lives in
   *  export.local-sources.ts keyed by id. */
  upstreamPath: string;
  /** Where the same data is served to the app, shown in the UI for transparency. */
  publicPath: string;
  params: ExportParamSpec[];
  pagination: ExportPagination;
  /** Row ceiling for this dataset; never above EXPORT_MAX_ROWS. */
  maxRows: number;
  /**
   * Rows per upstream page when the source refuses the default. The Prisma
   * repositories validate `limit` at max 100, so asking for 500 makes them
   * throw — which only showed on a full export, never on a 5-row preview.
   */
  pageSize?: number;
}

const TIME_WINDOW: ExportParamSpec[] = [
  {
    key: 'start_time',
    label: 'From',
    type: 'datetime',
    help: 'ISO-8601 UTC, e.g. 2026-07-01T00:00:00Z',
  },
  { key: 'end_time', label: 'To', type: 'datetime', help: 'ISO-8601 UTC' },
];

const ORDER: ExportParamSpec = {
  key: 'order',
  label: 'Order',
  type: 'enum',
  options: ['desc', 'asc'],
};

const COIN: ExportParamSpec = {
  key: 'coin',
  label: 'Coin',
  type: 'string',
  placeholder: 'all',
};

const SIDE: ExportParamSpec = {
  key: 'side',
  label: 'Side',
  type: 'enum',
  options: ['B', 'A'],
  help: 'B = buy, A = sell',
};

const USER: ExportParamSpec = {
  key: 'user',
  label: 'Trader address',
  type: 'address',
  placeholder: '0x… — empty for the market-wide feed',
};

const SIZE_USD: ExportParamSpec = {
  key: 'size_usd',
  label: 'Min size (USD)',
  type: 'number',
  placeholder: '0',
};

/**
 * Deliberately absent, verified empty upstream on 2026-07-26 rather than
 * merely unused: `/spot/auctions/hist` and `/vaults/vaultLedger` both answer
 * `[]` for every input tried (the latter across several vault addresses).
 * Listing them would promise an export that always produces an empty file.
 */
export const EXPORT_DATASETS: ExportDataset[] = [
  // ───────────────────────────── Trading ─────────────────────────────
  {
    id: 'perp-fills',
    label: 'Perp fills',
    group: 'Trading',
    source: 'hypedexer',
    description: 'Every fill on the perpetuals order book.',
    upstreamPath: '/fills/',
    publicPath: '/indexer/fills',
    params: [...TIME_WINDOW, COIN, SIDE, USER, SIZE_USD, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'spot-fills',
    label: 'Spot fills',
    group: 'Trading',
    source: 'hypedexer',
    description: 'Every fill on the spot order book.',
    upstreamPath: '/fills/spot/',
    publicPath: '/indexer/fills/spot',
    params: [...TIME_WINDOW, COIN, SIDE, USER, SIZE_USD, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'liquidations',
    label: 'Liquidations',
    group: 'Trading',
    source: 'hypedexer',
    description: 'Liquidation events with side, size and price.',
    upstreamPath: '/liquidations/',
    publicPath: '/liquidations',
    params: [...TIME_WINDOW, COIN, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'completed-trades',
    label: 'Completed trades',
    group: 'Trading',
    source: 'hypedexer',
    description: 'Round-trip trades reconstructed from fills, with realised PnL.',
    upstreamPath: '/completed-trades/',
    publicPath: '/indexer/completed-trades',
    params: [...TIME_WINDOW, COIN, USER, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'twaps',
    label: 'TWAP orders',
    group: 'Trading',
    source: 'hypedexer',
    description: 'TWAP orders with their fill progress.',
    upstreamPath: '/twaps/',
    publicPath: '/indexer/twaps',
    params: [COIN, USER, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'funding-history',
    label: 'Funding history',
    group: 'Trading',
    source: 'hypedexer',
    description: 'Historical funding rates per coin.',
    upstreamPath: '/funding/fundingHistory',
    publicPath: '/indexer/funding/fundingHistory',
    // Upstream answers 422 without a coin: funding is per-market by nature.
    params: [{ ...COIN, placeholder: 'HYPE', required: true }, ...TIME_WINDOW],
    pagination: 'none',
    maxRows: EXPORT_MAX_ROWS,
  },

  // ───────────────────────────── Chain ─────────────────────────────
  {
    id: 'evm-blocks',
    label: 'EVM blocks',
    group: 'Chain',
    source: 'hypedexer',
    description: 'HyperEVM blocks.',
    upstreamPath: '/evm/blocks',
    publicPath: '/indexer/evm/blocks',
    params: [...TIME_WINDOW, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'evm-transactions',
    label: 'EVM transactions',
    group: 'Chain',
    source: 'hypedexer',
    description: 'HyperEVM transactions.',
    upstreamPath: '/evm/transactions',
    publicPath: '/indexer/evm/transactions',
    params: [...TIME_WINDOW, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'evm-transfers',
    label: 'EVM transfers',
    group: 'Chain',
    source: 'hypedexer',
    description: 'Ledger transfers between HyperEVM and the L1.',
    upstreamPath: '/evm/ledger/transfers',
    publicPath: '/indexer/evm/ledger/transfers',
    params: [...TIME_WINDOW, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'evm-bridge-events',
    label: 'EVM bridge events',
    group: 'Chain',
    source: 'hypedexer',
    description: 'Bridge deposits and withdrawals.',
    upstreamPath: '/evm/bridge/events',
    publicPath: '/indexer/evm/bridge/events',
    params: [...TIME_WINDOW, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },

  // ───────────────────────────── Markets ─────────────────────────────
  {
    id: 'spot-pairs',
    label: 'Spot pairs',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Every spot pair known to the indexer.',
    upstreamPath: '/spot/pairs',
    publicPath: '/indexer/spot/pairs',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'spot-tokens',
    label: 'Spot tokens',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Spot token registry.',
    upstreamPath: '/spot/tokens',
    publicPath: '/indexer/spot/tokens',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip3-assets',
    label: 'HIP-3 assets',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Builder-deployed perp markets.',
    upstreamPath: '/hip3/assets',
    publicPath: '/indexer/hip3/assets',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip3-dexs',
    label: 'HIP-3 dexs',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Perp dexs and their deployers.',
    upstreamPath: '/hip3/dexs',
    publicPath: '/indexer/hip3/dexs',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip3-auctions',
    label: 'HIP-3 auctions',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Historical perp deploy auctions.',
    upstreamPath: '/hip3/auctions/history',
    publicPath: '/indexer/hip3/auctions/history',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip3-fills',
    label: 'HIP-3 fills',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Fills on builder-deployed perp markets.',
    upstreamPath: '/hip3/fills',
    publicPath: '/indexer/hip3/fills',
    params: [...TIME_WINDOW, COIN, USER, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip4-markets',
    label: 'HIP-4 markets',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Prediction markets with their enriched metadata.',
    upstreamPath: '/hip4/markets',
    publicPath: '/indexer/hip4/markets-enriched',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip4-fills',
    label: 'HIP-4 fills',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Fills on outcome markets.',
    upstreamPath: '/hip4/fills',
    publicPath: '/indexer/hip4/fills',
    params: [...TIME_WINDOW, USER, ORDER],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'hip4-settlements',
    label: 'HIP-4 settlements',
    group: 'Markets',
    source: 'hypedexer',
    description: 'Resolved outcome markets and their settlement.',
    upstreamPath: '/hip4/settlements',
    publicPath: '/indexer/hip4/settlements',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },

  // ───────────────────────────── Capital ─────────────────────────────
  {
    id: 'vault-summaries',
    label: 'Vaults',
    group: 'Capital',
    source: 'hypedexer',
    description: 'Vault summaries with follower counts.',
    upstreamPath: '/vaults/vaultSummaries',
    publicPath: '/indexer/vaults/vaultSummaries',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'traders-leaderboard',
    label: 'Traders leaderboard',
    group: 'Capital',
    source: 'hypedexer',
    description: 'Traders ranked by PnL and volume.',
    upstreamPath: '/users/leaderboard',
    publicPath: '/indexer/users/leaderboard',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'top-traders',
    label: 'Top traders 24h',
    group: 'Capital',
    source: 'hypedexer',
    description: 'Best performing traders over the last 24 hours.',
    upstreamPath: '/overview/top-traders-24h',
    publicPath: '/top-traders',
    params: [],
    pagination: 'none',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'active-users',
    label: 'Active users',
    group: 'Capital',
    source: 'hypedexer',
    description: 'Most active addresses by fill count.',
    upstreamPath: '/users/active',
    publicPath: '/active-users',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },

  // ───────────────────────────── Ecosystem ─────────────────────────────
  {
    id: 'builders',
    label: 'Builders',
    group: 'Ecosystem',
    source: 'hypedexer',
    description: 'Builder codes with their fee take.',
    upstreamPath: '/builders/list',
    publicPath: '/builders',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },

  // ─────────────────── Served by this backend, not the indexer ───────────────────
  // The tables the app actually renders. A catalog built only from HypeDexer
  // offered none of them, which is the gap this block closes.
  {
    id: 'spot-markets',
    label: 'Spot markets',
    group: 'Markets',
    source: 'local',
    description: 'Every spot market with price, 24h change, volume and market cap.',
    upstreamPath: '',
    publicPath: '/market/spot',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'perp-markets',
    label: 'Perp markets',
    group: 'Markets',
    source: 'local',
    description: 'Every perpetual market with price, funding, open interest and volume.',
    upstreamPath: '',
    publicPath: '/market/perp',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'vaults',
    label: 'Vaults (full)',
    group: 'Capital',
    source: 'local',
    description: 'Vault directory with TVL, APR, leader and creation date. Richer than the indexer summaries.',
    upstreamPath: '',
    publicPath: '/market/vaults',
    params: [
      {
        key: 'includeClosed',
        label: 'Include closed',
        type: 'enum',
        options: ['true'],
        help: 'Closed vaults are excluded by default.',
      },
    ],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'validators',
    label: 'Validators',
    group: 'Capital',
    source: 'local',
    description: 'Validator set with stake, commission, APR and uptime.',
    upstreamPath: '',
    publicPath: '/staking/validators',
    params: [],
    pagination: 'none',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'unstaking-queue',
    label: 'Unstaking queue',
    group: 'Capital',
    source: 'local',
    description: 'Pending HYPE unstaking requests.',
    upstreamPath: '',
    publicPath: '/staking/unstaking-queue',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'xp-leaderboard',
    label: 'XP leaderboard',
    group: 'Capital',
    source: 'local',
    description: 'Community leaderboard with XP, level and rank.',
    upstreamPath: '',
    publicPath: '/leaderboard',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'fees-history',
    label: 'Fees history',
    group: 'Trading',
    source: 'local',
    description: 'Daily protocol fees, raw series.',
    upstreamPath: '',
    publicPath: '/market/fees/raw',
    params: [],
    pagination: 'none',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'projects',
    pageSize: 100,
    label: 'Ecosystem projects',
    group: 'Ecosystem',
    source: 'local',
    description: 'The project directory: name, description, category and links.',
    upstreamPath: '',
    publicPath: '/project',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'wiki-resources',
    pageSize: 100,
    label: 'Wiki resources',
    group: 'Ecosystem',
    source: 'local',
    description: 'Approved wiki resources with their categories and save counts.',
    upstreamPath: '',
    publicPath: '/educational/resources',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
  {
    id: 'public-readlists',
    pageSize: 100,
    label: 'Public read lists',
    group: 'Ecosystem',
    source: 'local',
    description: 'Community read lists with their item counts.',
    upstreamPath: '',
    publicPath: '/readlists/public',
    params: [],
    pagination: 'offset',
    maxRows: EXPORT_MAX_ROWS,
  },
];

const BY_ID = new Map(EXPORT_DATASETS.map((d) => [d.id, d]));

export function getExportDataset(id: string): ExportDataset | undefined {
  return BY_ID.get(id);
}

/** Param keys a dataset accepts; anything else in the query is rejected. */
export function allowedParamKeys(dataset: ExportDataset): Set<string> {
  return new Set(dataset.params.map((p) => p.key));
}
