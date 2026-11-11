/**
 * Pure helpers for the Elysium analytics routes (day series, precompile
 * labels, retention math). No I/O so they stay unit-testable.
 */

const DAY_MS = 86_400_000;

/** Arbitrum Nitro precompiles and well-known system addresses (by low byte). */
const PRECOMPILE_LABELS: Record<number, string> = {
  0x64: 'ArbSys',
  0x65: 'ArbInfo',
  0x66: 'ArbAddressTable',
  0x68: 'ArbAggregator',
  0x69: 'ArbStatistics',
  0x6b: 'ArbOwnerPublic',
  0x6c: 'ArbGasInfo',
  0x6e: 'ArbRetryableTx',
  0x70: 'ArbOwner',
  0xc8: 'NodeInterface',
};

const PRECOMPILE_RE = /^0x0{38}([0-9a-f]{2})$/i;

/** SQL LIKE pattern matching 0x0000…00XX addresses. */
export const PRECOMPILE_LIKE = `0x${'0'.repeat(38)}__`;

/** Label for a 0x0000…00XX address, or null when it is not a precompile. */
export function precompileLabel(address: string): string | null {
  const m = PRECOMPILE_RE.exec(address);
  if (!m) return null;
  return PRECOMPILE_LABELS[parseInt(m[1], 16)] ?? 'Precompile';
}

/** UTC midnight of the given date. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day keys (YYYY-MM-DD, ascending) of the last `days` UTC days, today included. */
export function lastDays(now: Date, days: number): string[] {
  const today = utcMidnight(now).getTime();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(new Date(today - i * DAY_MS)));
  return out;
}

/** Normalises a DB date/timestamp/day string to a YYYY-MM-DD key. */
export function toDayKey(v: Date | string): string {
  return typeof v === 'string' ? v.slice(0, 10) : dayKey(v);
}

/**
 * Builds one row per day in `dayKeys` (zero-filled from `zero`), merging the
 * DB rows keyed by day, and flags today's row as partial.
 */
export function fillDays<T extends object>(
  dayKeys: string[],
  rows: Map<string, T>,
  zero: () => T,
  now: Date
): Array<{ day: string; partial: boolean } & T> {
  const today = dayKey(now);
  return dayKeys.map((day) => ({ day, partial: day === today, ...(rows.get(day) ?? zero()) }));
}

/**
 * Retention fraction for cohort `cohortDay` at `offsetDays`, or null while the
 * offset day is not complete yet (it must end before `now`).
 */
export function retentionFraction(
  cohortDay: string,
  offsetDays: number,
  size: number,
  retained: number,
  now: Date
): number | null {
  const offsetDayEnd = new Date(`${cohortDay}T00:00:00Z`).getTime() + (offsetDays + 1) * DAY_MS;
  if (offsetDayEnd > now.getTime()) return null;
  if (size <= 0) return null;
  return retained / size;
}

/** Share of `part` in `total`, 0 when total is 0. */
export function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/**
 * The status route is public: serve a fixed category, never the raw message,
 * which can name upstream hosts or the internal database address. The full
 * text stays in the database and the logs.
 */
export function errorCategory(message: string | null): string | null {
  if (!message) return null;
  const http = /API error:?\s*(\d{3})/i.exec(message);
  if (http) return `upstream_http_${http[1]}`;
  if (/tick given up/i.test(message)) return 'tick_time_limit';
  if (/time(d)? ?out/i.test(message)) return 'timeout';
  if (/prisma|database|can't reach|ECONNREFUSED|ECONNRESET/i.test(message)) return 'db_error';
  if (/page/i.test(message)) return 'page_cap';
  return 'error';
}

/**
 * What each ingestion stream is expected to do: how often it runs, and what its cursor is the
 * time of. `data`: the data it has stored, on a chain that never stops (a lag is then
 * meaningful, and late data is a fault). `events`: its newest event (the bridge's newest
 * transfer): its age is shown, and is no fault, since nobody may have bridged for an hour.
 * `run`: its last run (the cursor says nothing of the data). `fallback`: the RPC reading of live
 * transactions, which only works while the provider lags and is otherwise at rest, whatever its
 * cursor says.
 */
export const STREAM_EXPECTATIONS: Readonly<Record<string, { everyS: number; kind: 'data' | 'events' | 'run' | 'fallback' }>> = {
  tx: { everyS: 30, kind: 'data' },
  dex: { everyS: 60, kind: 'data' },
  launchpad: { everyS: 30, kind: 'data' },
  bridge: { everyS: 60, kind: 'events' },
  txlive: { everyS: 60, kind: 'fallback' },
  tokens: { everyS: 900, kind: 'run' },
  methods: { everyS: 1800, kind: 'run' },
  tokenstats: { everyS: 900, kind: 'run' },
  launchstats: { everyS: 300, kind: 'run' },
};

/** Behind the clock by more than this, the provider counts as lagging (as the ingestion decides it). */
const PROVIDER_LAG_S = 120;
/** A stream whose last completed run is older than this many of its periods (and than 5 minutes) is not running. */
const STALLED_PERIODS = 3;
/** Data older than this many periods (and than 5 minutes) is late. */
const BEHIND_PERIODS = 5;

export type StreamState =
  /** Running, and its data is current. */
  | 'ok'
  /** Its last run failed. */
  | 'failing'
  /** No completed run for several periods: its loop is not running. */
  | 'stalled'
  /** Its data stops where the provider's index stops: nothing to read until the provider moves on. */
  | 'waiting-provider'
  /** It runs and has not read the chain's history to the end yet: its data is old because it is still on its way. */
  | 'backfilling'
  /** Its data is late while the provider is not. */
  | 'behind';

export interface StreamHealth {
  /** Seconds between the clock and the stream's data; null for a stream whose cursor is not the time of its data. */
  lagSeconds: number | null;
  everyS: number | null;
  state: StreamState;
}

/**
 * How a stream is doing, from its row. The lag shown used to be `now - cursor` for every stream:
 * near zero for the ones whose cursor is the time of their run even when the provider returned
 * nothing, and hours for the RPC fallback while it was simply at rest. An alert on that figure
 * would have rung for nothing, or never.
 */
export function streamHealth(
  row: { stream: string; cursor: Date | null; lastError: string | null; okAt: Date | null; backfillDone?: boolean },
  now: number,
  providerHead: Date | null
): StreamHealth {
  const expected = STREAM_EXPECTATIONS[row.stream];
  // A row nothing here knows of (a stream of another version): its error is shown, and it is
  // not judged by a cadence it does not have. It used to count as stalled, for ever.
  if (!expected) return { lagSeconds: null, everyS: null, state: row.lastError ? 'failing' : 'ok' };
  const { everyS, kind } = expected;
  const dated = kind === 'data' || kind === 'events';
  const lagSeconds = dated && row.cursor ? Math.max(0, Math.round((now - row.cursor.getTime()) / 1000)) : null;
  if (row.lastError) return { lagSeconds, everyS, state: 'failing' };
  const period = everyS * 1000;
  if (row.okAt === null || now - row.okAt.getTime() > Math.max(STALLED_PERIODS * period, 300_000)) {
    return { lagSeconds, everyS, state: 'stalled' };
  }
  const providerLate = providerHead !== null && now - providerHead.getTime() > PROVIDER_LAG_S * 1000;
  // The bridge runs, and its newest transfer is as old as it is: nobody bridged since. Only the
  // provider standing still is worth saying, since the bridge reads nothing but the provider.
  if (kind === 'events') return { lagSeconds, everyS, state: providerLate ? 'waiting-provider' : 'ok' };
  if (lagSeconds === null || lagSeconds * 1000 <= Math.max(BEHIND_PERIODS * period, 300_000)) return { lagSeconds, everyS, state: 'ok' };
  // Late data from a stream that is still reading the history for the first time (a new database,
  // a new stream): it is where it should be, and saying "behind" would ring for hours for nothing.
  if (row.backfillDone === false) return { lagSeconds, everyS, state: 'backfilling' };
  // Late data. The provider's own index is late too: the stream has read all there is. (The log
  // streams read past the provider's head from the RPC, so they have no such excuse.)
  return { lagSeconds, everyS, state: providerLate && row.stream === 'tx' ? 'waiting-provider' : 'behind' };
}
