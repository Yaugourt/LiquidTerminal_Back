/**
 * Parse docs/hypedexer_endpoints.json (OpenAPI 3.x) and emit:
 * - docs/hypedexer_endpoints.inventory.md — paths, methods, tags, coverage vs polling REST clients
 *
 * Run: npm run hypedexer:inventory
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'hypedexer_endpoints.json');
const OUT_MD = path.join(ROOT, 'docs', 'hypedexer_endpoints.inventory.md');

/** Upstream paths proxied via src/clients/hypedexer/rest + src/routes/indexer (new stack). */
const HYPEDEXER_REST_INDEXER_MOUNT: Array<{ method: string; path: string; source: string }> = [
  { method: 'GET', path: '/fills/', source: 'HypeDexerFillsClient + /indexer/fills' },
  { method: 'GET', path: '/fills/recent', source: 'HypeDexerFillsClient + /indexer/fills/recent' },
  { method: 'GET', path: '/fills/count', source: 'HypeDexerFillsClient + /indexer/fills/count' },
  { method: 'GET', path: '/fills/user/{user_address}', source: 'HypeDexerFillsClient + /indexer/fills/user/:user_address' },
  { method: 'GET', path: '/fills/spot/', source: 'HypeDexerFillsClient + /indexer/fills/spot' },
  { method: 'GET', path: '/fills/spot/user/{user_address}', source: 'HypeDexerFillsClient + /indexer/fills/spot/user/:user_address' },
  { method: 'GET', path: '/funding/fundingHistory', source: 'HypeDexerFundingClient + /indexer/funding/fundingHistory' },
  { method: 'GET', path: '/funding/predictedFundings', source: '… + /indexer/funding/predictedFundings' },
  { method: 'GET', path: '/funding/userFunding', source: '… + /indexer/funding/userFunding' },
  { method: 'GET', path: '/users/leaderboard', source: 'HypeDexerUsersIndexerClient + /indexer/users/leaderboard' },
  { method: 'GET', path: '/overview/active-traders-24h', source: 'HypeDexerOverviewIndexerClient + /indexer/overview/active-traders-24h' },
  { method: 'GET', path: '/overview/coin-distribution', source: '… + /indexer/overview/coin-distribution' },
  { method: 'GET', path: '/overview/daily-pnl-10d', source: '… + /indexer/overview/daily-pnl-10d' },
  { method: 'GET', path: '/overview/daily-volume-10d', source: '… + /indexer/overview/daily-volume-10d' },
  { method: 'GET', path: '/overview/total-fees-24h', source: '… + /indexer/overview/total-fees-24h' },
  { method: 'GET', path: '/overview/total-fills-24h', source: '… + /indexer/overview/total-fills-24h' },
  { method: 'GET', path: '/overview/trading-volume-24h', source: '… + /indexer/overview/trading-volume-24h' },
  { method: 'GET', path: '/analytics/fills/stats', source: 'HypeDexerAnalyticsIndexerClient + /indexer/analytics/fills/stats' },
  {
    method: 'GET',
    path: '/analytics/priority-fees/stats',
    source: 'HypeDexerAnalyticsIndexerClient + /indexer/analytics/priority-fees/stats',
  },
  {
    method: 'GET',
    path: '/analytics/priority-fees/fills-timeseries',
    source:
      'IndexerPriorityFeesAggregationService (aggregates GET /fills/) + /indexer/analytics/priority-fees/fills-timeseries',
  },
  { method: 'GET', path: '/builders/list', source: 'HypeDexerBuildersIndexerClient + /indexer/builders/list' },
  { method: 'GET', path: '/builders/stats', source: '… + /indexer/builders/stats' },
  { method: 'GET', path: '/builders/stats/all-timeframes', source: '… + /indexer/builders/stats/all-timeframes' },
  { method: 'GET', path: '/builders/top', source: '… + /indexer/builders/top' },
  { method: 'GET', path: '/builders/{builder_address}/stats', source: '… + /indexer/builders/:builder_address/stats' },
  { method: 'GET', path: '/builders/{builder_address}/users', source: '… + /indexer/builders/:builder_address/users' },
  { method: 'GET', path: '/completed-trades/', source: 'HypeDexerCompletedTradesClient + /indexer/completed-trades' },
  { method: 'GET', path: '/completed-trades/summary', source: '… + /indexer/completed-trades/summary' },
  { method: 'GET', path: '/completed-trades/{trade_id}/fills', source: '… + /indexer/completed-trades/:trade_id/fills' },
  { method: 'GET', path: '/hip3/assets', source: 'HypeDexerHip3Client + /indexer/hip3/assets' },
  { method: 'GET', path: '/hip3/assets/{ticker}', source: '… + /indexer/hip3/assets/:ticker' },
  { method: 'GET', path: '/hip3/dexs', source: '… + /indexer/hip3/dexs' },
  { method: 'GET', path: '/hip3/dexs/{dex_id}', source: '… + /indexer/hip3/dexs/:dex_id' },
  { method: 'GET', path: '/hip3/overview', source: '… + /indexer/hip3/overview' },
  {
    method: 'GET',
    path: '/hip3/priority-fees/gossip/status',
    source: 'HypeDexerHip3Client + /indexer/hip3/priority-fees/gossip/status',
  },
  {
    method: 'GET',
    path: '/hip3/priority-fees/gossip/history',
    source: 'HypeDexerHip3Client + /indexer/hip3/priority-fees/gossip/history',
  },
  { method: 'GET', path: '/hip3/auctions', source: '… + /indexer/hip3/auctions' },
  { method: 'GET', path: '/hip3/auctions/current', source: '… + /indexer/hip3/auctions/current' },
  { method: 'GET', path: '/hip3/auctions/history', source: '… + /indexer/hip3/auctions/history' },
  { method: 'GET', path: '/hip3/fills', source: '… + /indexer/hip3/fills' },
  { method: 'GET', path: '/hip3/leaderboard', source: '… + /indexer/hip3/leaderboard' },
  { method: 'GET', path: '/hip3/ohlcv', source: '… + /indexer/hip3/ohlcv' },
  { method: 'GET', path: '/hip3/oracle/stats', source: '… + /indexer/hip3/oracle/stats' },
  { method: 'GET', path: '/hip3/snapshots', source: '… + /indexer/hip3/snapshots' },
  { method: 'GET', path: '/hip3/stats/traders', source: '… + /indexer/hip3/stats/traders' },
  { method: 'GET', path: '/hip3/top-movers', source: '… + /indexer/hip3/top-movers' },
  { method: 'GET', path: '/hip3/users/{address}/coins', source: '… + /indexer/hip3/users/:address/coins' },
  { method: 'GET', path: '/hip3/users/{address}/fills', source: '… + /indexer/hip3/users/:address/fills' },
  { method: 'GET', path: '/hip3/users/{address}/overview', source: '… + /indexer/hip3/users/:address/overview' },
  { method: 'GET', path: '/spot/auctions/hist', source: 'HypeDexerSpotIndexerClient + /indexer/spot/auctions/hist' },
  { method: 'GET', path: '/spot/auctions/live', source: '… + /indexer/spot/auctions/live' },
  { method: 'GET', path: '/spot/pairs', source: '… + /indexer/spot/pairs' },
  { method: 'GET', path: '/spot/tokens', source: '… + /indexer/spot/tokens' },
  { method: 'GET', path: '/twaps/', source: 'HypeDexerTwapsClient + /indexer/twaps' },
  { method: 'GET', path: '/twaps/stats', source: '… + /indexer/twaps/stats' },
  { method: 'GET', path: '/twaps/user/{user_address}', source: '… + /indexer/twaps/user/:user_address' },
  { method: 'GET', path: '/twaps/{twap_id}', source: '… + /indexer/twaps/:twap_id' },
  { method: 'GET', path: '/twaps/{twap_id}/fills', source: '… + /indexer/twaps/:twap_id/fills' },
  { method: 'GET', path: '/users/{user}/coins', source: 'HypeDexerUsersIndexerClient + /indexer/users/:user/coins' },
  { method: 'GET', path: '/users/{user}/overview', source: '… + /indexer/users/:user/overview' },
  { method: 'GET', path: '/users/{user}/performance', source: '… + /indexer/users/:user/performance' },
  { method: 'GET', path: '/vaults/dailySnapshots', source: 'HypeDexerVaultsIndexerClient + /indexer/vaults/dailySnapshots' },
  { method: 'GET', path: '/vaults/equitySnapshots', source: '… + /indexer/vaults/equitySnapshots' },
  { method: 'GET', path: '/vaults/userVaultEquities', source: '… + /indexer/vaults/userVaultEquities' },
  { method: 'GET', path: '/vaults/vaultDetails', source: '… + /indexer/vaults/vaultDetails' },
  { method: 'GET', path: '/vaults/vaultLedger', source: '… + /indexer/vaults/vaultLedger' },
  { method: 'GET', path: '/vaults/vaultSummaries', source: '… + /indexer/vaults/vaultSummaries' },
];

/** Upstream paths + methods called from polling clients under src/clients/hypedexer/rest (app routes). */
const HLINDEXER_REST_IMPLEMENTED: Array<{ method: string; path: string; source: string }> = [
  { method: 'GET', path: '/liquidations/', source: 'rest/liquidations/liquidations.client.ts' },
  { method: 'GET', path: '/liquidations/recent', source: 'rest/liquidations/liquidations.client.ts' },
  { method: 'GET', path: '/analytics/liquidations/stats', source: 'rest/liquidations/liquidations.client.ts' },
  { method: 'GET', path: '/overview/top-traders-24h', source: 'rest/toptraders/toptraders.client.ts' },
  { method: 'GET', path: '/users/active', source: 'rest/activeusers/activeusers.client.ts' },
  {
    method: 'GET',
    path: '/builders/list',
    source:
      'rest/builders/builders-list-poller.client.ts (GET /builders/list?limit=1000&offset=0&sort=volume_usd&order=DESC)',
  },
];

function normalizePath(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1) || '/';
  return p;
}

function pathMatchesImplemented(openapiPath: string, method: string): 'implemented' | 'partial' | 'missing' {
  const norm = normalizePath(openapiPath);
  const m = method.toUpperCase();

  for (const row of HLINDEXER_REST_IMPLEMENTED) {
    if (row.method !== m) continue;
    const target = normalizePath(row.path);
    if (norm === target) return 'implemented';
  }

  for (const row of HYPEDEXER_REST_INDEXER_MOUNT) {
    if (row.method !== m) continue;
    const target = normalizePath(row.path);
    if (norm === target) return 'implemented';
  }

  return 'missing';
}

interface Row {
  method: string;
  path: string;
  tags: string;
  operationId: string;
  status: 'implemented' | 'partial' | 'missing' | 'ws_note';
}

function main(): void {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`Missing OpenAPI file: ${SPEC_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  if (!raw.trim()) {
    console.error(`OpenAPI file is empty: ${SPEC_PATH}. Restore from partner or: curl -sS https://api.hypedexer.com/openapi.json -o docs/hypedexer_endpoints.json`);
    process.exit(1);
  }

  let doc: { paths: Record<string, Record<string, unknown>> };
  try {
    doc = JSON.parse(raw) as { paths: Record<string, Record<string, unknown>> };
  } catch (e) {
    console.error('Invalid JSON in OpenAPI file:', e);
    process.exit(1);
  }

  const rows: Row[] = [];
  const pathKeys = Object.keys(doc.paths || {}).sort();

  for (const p of pathKeys) {
    const item = doc.paths[p];
    const methods = Object.keys(item).filter((k) => !k.startsWith('x-') && k !== 'parameters');
    for (const method of methods) {
      const op = item[method] as {
        tags?: string[];
        operationId?: string;
      };
      const tags = (op.tags || []).join(', ') || '—';
      const operationId = op.operationId || '—';
      let status: Row['status'];
      if (p === '/ws') {
        status = 'ws_note';
      } else {
        status = pathMatchesImplemented(p, method);
      }
      rows.push({ method: method.toUpperCase(), path: p, tags, operationId, status });
    }
  }

  const implemented = rows.filter((r) => r.status === 'implemented').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const missing = rows.filter((r) => r.status === 'missing').length;
  const ws = rows.filter((r) => r.status === 'ws_note').length;

  const lines: string[] = [
    '# HypeDexer (HL Indexer) OpenAPI inventory',
    '',
    '> **Generated** by `npm run hypedexer:inventory`. Do not edit by hand; regenerate after updating `docs/hypedexer_endpoints.json`.',
    '',
    '## Proxied via `/indexer/*` (hypedexer/rest)',
    '',
    '| Method | Upstream path | Notes |',
    '|--------|---------------|-------|',
    ...HYPEDEXER_REST_INDEXER_MOUNT.map((r) => `| ${r.method} | \`${r.path}\` | ${r.source} |`),
    '',
    '## Summary',
    '',
    `- **OpenAPI paths (operations):** ${rows.length}`,
    `- **Implemented** (exact match to polling REST clients under hypedexer/rest): ${implemented}`,
    `- **Partial** (spec differs from current client URL): ${partial}`,
    `- **Missing**: ${missing}`,
    `- **WebSocket note** (\`/ws\`): ${ws}`,
    '',
    '## Polling REST clients (hypedexer/rest — app routes)',
    '',
    '| Method | Path | Source |',
    '|--------|------|--------|',
    ...HLINDEXER_REST_IMPLEMENTED.map(
      (r) => `| ${r.method} | \`${r.path}\` | ${r.source} |`
    ),
    '',
    '## Full operation matrix',
    '',
    '| Status | Method | Path | Tags | operationId |',
    '|--------|--------|------|------|-------------|',
    ...rows.map((r) => {
      const st =
        r.status === 'ws_note'
          ? 'WS (use websocket client, not REST)'
          : r.status === 'implemented'
            ? 'Implemented'
            : r.status === 'partial'
              ? 'Partial'
              : 'Missing';
      return `| ${st} | ${r.method} | \`${r.path}\` | ${r.tags} | \`${r.operationId}\` |`;
    }),
    '',
    '## Redis / rate-limit notes',
    '',
    '- Per-route weights are **not** present in this OpenAPI file; keep `REQUEST_WEIGHT` + `MAX_WEIGHT_PER_MINUTE` per **domain client** (see `constants/hypedexer.cache.ts`).',
    '- Prefer **on-demand** + short TTL for heavy paths (e.g. `/fills/`); use **polling + distributed lock** only for hot aggregate keys.',
    '',
  ];

  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  console.log(`Wrote ${OUT_MD}`);
  console.log(`Summary: implemented=${implemented} partial=${partial} missing=${missing} ws=${ws}`);
}

main();
