#!/usr/bin/env node
/**
 * One-off script: Compare HypeDexer API vs Historical DB for last 24h liquidations
 *
 * Run: node scripts/compare-liquidations-24h.mjs
 *
 * 1. Loads HL_INDEXER_API_KEY from .env
 * 2. Calls /analytics/liquidations/stats?days=1
 * 3. Calls /liquidations with start_time/end_time for last 24h (paginated)
 * 4. Outputs raw count and total volume (sum notional_total)
 * 5. Compares with historical DB
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env');
const API_BASE = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';

function loadEnv() {
  try {
    const content = readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch (e) {
    console.error('Failed to load .env:', e.message);
    process.exit(1);
  }
}

function getApiKey() {
  const key = process.env.HL_INDEXER_API_KEY;
  if (!key) {
    console.error('HL_INDEXER_API_KEY not found in .env');
    process.exit(1);
  }
  return key;
}

function getTimeRange24h() {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    since: start,
  };
}

async function fetchAnalyticsStats(apiKey) {
  const url = `${API_BASE}/analytics/liquidations/stats?days=1`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Analytics stats failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchLiquidationsRaw(apiKey, startTime, endTime) {
  let totalCount = 0;
  let totalVolume = 0;
  let cursor = null;
  let page = 0;

  do {
    const params = new URLSearchParams();
    params.set('start_time', startTime);
    params.set('end_time', endTime);
    params.set('limit', '1000');
    params.set('order', 'ASC');
    if (cursor) params.set('cursor', cursor);

    const url = `${API_BASE}/liquidations?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Liquidations fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const items = data.data || [];
    totalCount += items.length;
    for (const item of items) {
      totalVolume += Number(item.notional_total || 0);
    }
    cursor = data.has_more ? data.next_cursor : null;
    page++;
    if (items.length > 0) {
      console.log(`  Page ${page}: +${items.length} items (cumulative: ${totalCount})`);
    }
  } while (cursor);

  return { totalCount, totalVolume };
}

async function queryHistoricalDb(since) {
  const url = process.env.HISTORICAL_DATABASE_URL;
  if (!url) {
    return null;
  }
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::bigint as count, COALESCE(SUM(notional_total), 0)::float as total_volume
       FROM raw_liquidations
       WHERE time >= $1`,
      [since]
    );
    const row = result.rows[0];
    return {
      count: Number(row.count),
      totalVolume: Number(row.total_volume),
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  loadEnv();
  const apiKey = getApiKey();
  const { start_time, end_time, since } = getTimeRange24h();

  console.log('\n=== Liquidations 24h Comparison ===\n');
  console.log('Time range:', start_time, '->', end_time);
  console.log('');

  // 1. Analytics stats
  console.log('1. HypeDexer /analytics/liquidations/stats?days=1');
  let analytics;
  try {
    analytics = await fetchAnalyticsStats(apiKey);
    console.log('   Count:', analytics.data?.number_liquidation ?? 'N/A');
    console.log('   Volume (USD):', analytics.data?.amount_liquidated_usd ?? 'N/A');
    if (analytics.data?.time_range) {
      console.log('   Time range:', analytics.data.time_range.start, '->', analytics.data.time_range.end);
    }
  } catch (e) {
    console.log('   ERROR:', e.message);
  }
  console.log('');

  // 2. Raw liquidations (paginated)
  console.log('2. HypeDexer /liquidations (start_time/end_time, paginated)');
  let raw;
  try {
    raw = await fetchLiquidationsRaw(apiKey, start_time, end_time);
    console.log('   Total count:', raw.totalCount);
    console.log('   Total volume (sum notional_total):', raw.totalVolume.toFixed(2), 'USD');
  } catch (e) {
    console.log('   ERROR:', e.message);
  }
  console.log('');

  // 3. Historical DB
  console.log('3. Historical DB (raw_liquidations, last 24h)');
  let historical;
  try {
    historical = await queryHistoricalDb(since);
    if (historical) {
      console.log('   Total count:', historical.count);
      console.log('   Total volume:', historical.totalVolume.toFixed(2), 'USD');
    } else {
      console.log('   SKIPPED: HISTORICAL_DATABASE_URL not set');
    }
  } catch (e) {
    console.log('   ERROR:', e.message);
  }
  console.log('');

  // 4. Comparison
  console.log('=== Comparison ===');
  if (analytics?.data && raw) {
    const countDiff = raw.totalCount - (analytics.data.number_liquidation ?? 0);
    const volDiff = raw.totalVolume - (analytics.data.amount_liquidated_usd ?? 0);
    console.log('Analytics vs Raw /liquidations:');
    console.log('  Count diff:', countDiff >= 0 ? `+${countDiff}` : countDiff);
    console.log('  Volume diff (USD):', volDiff >= 0 ? `+${volDiff.toFixed(2)}` : volDiff.toFixed(2));
    console.log('');
    console.log('>>> CONCLUSION: amount_liquidated_usd (analytics) != sum(notional_total) (raw)');
    console.log('>>> Le concurrent affiche probablement amount_liquidated_usd (~22M)');
    console.log('>>> Notre Explorer utilise notre DB = sum(notional_total) = ~7.6M max');
  }
  if (raw && historical) {
    const countDiff = historical.count - raw.totalCount;
    const volDiff = historical.totalVolume - raw.totalVolume;
    console.log('Historical DB vs Raw /liquidations:');
    console.log('  Count diff:', countDiff >= 0 ? `+${countDiff}` : countDiff);
    console.log('  Volume diff (USD):', volDiff >= 0 ? `+${volDiff.toFixed(2)}` : volDiff.toFixed(2));
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
