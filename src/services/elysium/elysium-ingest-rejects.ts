/**
 * What the ingestion read and did not store, counted by stream and reason.
 *
 * A row the decoders or the database refuse used to vanish: a launch event
 * from a contract nobody listed, a trade for a market never seen, a log the
 * RPC returned without its time, a window cut at the page cap. None of it
 * stopped a stream, and none of it left a trace, so a new version of a
 * launchpad contract could go unnoticed for weeks. Each of these is now
 * counted here, kept per UTC day in elysium_ingest_reject, and shown by the
 * status route.
 *
 * Counts are gathered in memory while a tick runs and written once it ends
 * (one small statement), so counting costs the streams nothing.
 *
 * The streams read the same rows more than once on purpose (a window starts
 * before its cursor, the bridge re-reads a day of transfers every 15 minutes,
 * a failed tick is run again): a reject noted with the key of its row is
 * counted the first time that key is seen by this process, and not again.
 */
export type RejectReason =
  /** A provider row without the fields a row needs (hash, sender, time, block). */
  | 'row-malformed'
  /** A row the database refused: set aside so the rest of its page is stored. */
  | 'row-refused'
  /** A text longer than its column, stored cut. */
  | 'text-truncated'
  /** A log without the fields a log needs. */
  | 'log-malformed'
  /** A log with a topic of ours whose data does not decode. */
  | 'log-undecodable'
  /** A launch event from a contract that is not on the launchpads' list (spam, or a new version). */
  | 'launch-unknown-emitter'
  /** A trade or a graduation emitted by a launchpad's own contract for a token never seen launching. */
  | 'market-unknown'
  /** A window read up to the page cap at the smallest step: the rest of it was not read. */
  | 'window-truncated'
  /** A token whose holder figures could not be read; it goes back in the queue. */
  | 'token-unreadable'
  /** A bridge transfer that could not be read again by its hash; it is tried again at the next sweep. */
  | 'transfer-unreadable'
  /** A closed day whose transaction count differs from the provider's. */
  | 'day-gap'
  /** A block that is no longer on the chain: the rows after the last common block were removed and read again. */
  | 'reorg'
  /** A transaction from before the oldest day elysium_tx still holds (old days are dropped on a set keep): not stored. */
  | 'older-than-kept';

export interface RejectCount {
  stream: string;
  reason: RejectReason;
  count: number;
  /** One example, for whoever looks into it (never served by the public status). */
  sample: string | null;
}

const SAMPLE_MAX = 400;
/** Row keys remembered as already counted (the oldest is forgotten first). */
const SEEN_MAX = 20_000;

export class IngestRejects {
  private pending = new Map<string, RejectCount>();
  private readonly seen = new Map<string, true>();

  /**
   * Counts `count` rows of `stream` left out for `reason`; the first sample of a batch is kept.
   * With `rowKey` (what identifies the row: a hash, an id, a window), a row already counted for
   * this reason is not counted again.
   */
  public note(stream: string, reason: RejectReason, sample?: string | null, count = 1, rowKey?: string): void {
    if (count <= 0) return;
    if (rowKey !== undefined) {
      const seenKey = `${stream}|${reason}|${rowKey}`;
      if (this.seen.has(seenKey)) return;
      if (this.seen.size >= SEEN_MAX) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      this.seen.set(seenKey, true);
    }
    const key = `${stream}|${reason}`;
    const entry = this.pending.get(key);
    if (entry) {
      entry.count += count;
      if (entry.sample === null && sample) entry.sample = sample.slice(0, SAMPLE_MAX);
    } else {
      this.pending.set(key, { stream, reason, count, sample: sample ? sample.slice(0, SAMPLE_MAX) : null });
    }
  }

  /** Everything counted since the last call, and starts over. */
  public take(): RejectCount[] {
    const rows = [...this.pending.values()];
    this.pending = new Map();
    return rows;
  }

  /** Puts back counts that could not be written, to be written with the next ones. */
  public restore(rows: RejectCount[]): void {
    for (const r of rows) this.note(r.stream, r.reason, r.sample, r.count);
  }

  public get size(): number {
    return this.pending.size;
  }
}
