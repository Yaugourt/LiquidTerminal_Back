/**
 * Pure helpers for builder code growth: UTC day arithmetic, the public file
 * URL, and the aggregation of one builder-day fill file.
 */

export const DAY_MS = 86_400_000;

/** First day Hyperliquid publishes builder fill files for (builder codes went live then). */
export const BUILDER_FILLS_GENESIS = '2024-10-27';

export const BUILDER_FILLS_BASE = 'https://stats-data.hyperliquid.xyz/Mainnet/builder_fills';

/** `YYYY-MM-DD` of a UTC date. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight of a `YYYY-MM-DD` day. */
export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return isoDay(new Date(parseDay(day).getTime() + n * DAY_MS));
}

/** Hours after a day closes before its file is trusted (files land around 01:00 UTC). */
const PUBLISH_DELAY_H = 3;

/**
 * Last day whose file is safe to read, so a missing file means "no fills"
 * rather than "not published yet".
 */
export function lastPublishedDay(now: Date = new Date()): string {
  const settled = Math.floor((now.getTime() - PUBLISH_DELAY_H * 3_600_000) / DAY_MS) * DAY_MS;
  return isoDay(new Date(settled - DAY_MS));
}

export function fileUrl(builder: string, day: string): string {
  return `${BUILDER_FILLS_BASE}/${builder.toLowerCase()}/${day.replace(/-/g, '')}.csv.lz4`;
}

/** Inclusive list of days from `from` to `to` (empty when from > to). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * First 8 bytes of an address as a signed int8, as a decimal string for SQL.
 * Addresses are uniformly random, so this key stays unique within a builder.
 */
export function userKey(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

export interface DayAggregate {
  fees: number;
  volume: number;
  fills: number;
  /** Distinct user keys (see `userKey`). */
  users: string[];
}

/**
 * Aggregate one builder-day CSV (header: time,user,coin,side,px,sz,...,builder_fee).
 * Volume is px * sz in the quote asset; fees are the published builder_fee.
 * The very first file (2024-10-27, 8 fills) predates the builder_fee column:
 * its fees count as zero, users and volume still count.
 */
export function aggregateCsv(csv: string): DayAggregate {
  const lines = csv.split('\n');
  const header = (lines[0] ?? '').trim().split(',');
  const iUser = header.indexOf('user');
  const iPx = header.indexOf('px');
  const iSz = header.indexOf('sz');
  const iFee = header.indexOf('builder_fee');
  if (iUser < 0 || iPx < 0 || iSz < 0) {
    throw new Error(`Unexpected builder fills header: ${lines[0]?.slice(0, 200)}`);
  }

  let fees = 0;
  let volume = 0;
  let fills = 0;
  const users = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    const user = cols[iUser];
    if (!user || !user.startsWith('0x')) continue;
    const px = Number(cols[iPx]);
    const sz = Number(cols[iSz]);
    const fee = iFee < 0 ? 0 : Number(cols[iFee]);
    if (Number.isFinite(px) && Number.isFinite(sz)) volume += px * sz;
    if (Number.isFinite(fee)) fees += fee;
    fills += 1;
    users.add(userKey(user));
  }
  return { fees, volume, fills, users: [...users] };
}
