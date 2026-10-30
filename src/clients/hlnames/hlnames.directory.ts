import { logDeduplicator } from '../../utils/logDeduplicator';
import { currentRegistrator, expiries } from './hlnames.chain';

/**
 * In-memory copy of every primary .hl name, so the site and the alerts read
 * names locally instead of asking HL Names per visit.
 *
 * - The list (about 3,000 names, 4 pages of 1,000) is pulled every 10 minutes
 *   with If-None-Match, so an unchanged page costs a bodyless 304.
 * - Expiries come from HyperEVM (Multicall3), never from their API. Their list
 *   still carries expired names (about two thirds on 2026-10-30); an expired
 *   name may belong to someone else tomorrow, so it is never shown.
 * - Until the first load succeeds, `ready` is false and callers fall back to
 *   the cached REST path.
 */

export interface DirectoryEntry {
  name: string;
  namehash: string;
  /** Unix seconds, null when unknown (chain read failed): the name is then not shown. */
  expiry: number | null;
}

export type ListPageFetcher = (begin: number, end: number, etag: string | null) => Promise<
  { status: 304 } | { status: 200; etag: string | null; rows: { address: string; primaryName: string; namehash: string }[] }
>;

const PAGE = 1_000;
const MAX_PAGES = 50;
const LIST_REFRESH_MS = 10 * 60_000;
const EXPIRY_REFRESH_MS = 60 * 60_000;
/** A cache drop after a mint may pull the list again, at most this often. */
const MIN_FORCED_GAP_MS = 60_000;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;

export class HlNamesDirectory {
  private byAddress = new Map<string, DirectoryEntry>();
  private byName = new Map<string, string>();
  private pages: { etag: string | null; rows: { address: string; primaryName: string; namehash: string }[] }[] = [];
  private expiryOf = new Map<string, number | null>();
  private registrator: string | null = null;
  private lastList = 0;
  private lastExpiry = 0;
  private lastForced = 0;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  ready = false;

  constructor(private readonly fetchPage: ListPageFetcher, private readonly now: () => number = Date.now) {}

  /** Starts the background refresh (first load right away). */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), LIST_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Primary name of an address: a string, null for none or expired, undefined while not ready. */
  primaryName(address: string): string | null | undefined {
    if (!this.ready) return undefined;
    const e = this.byAddress.get(address.toLowerCase());
    return e && this.isLive(e) ? e.name : null;
  }

  /** The live directory entry of an address (null for none or expired, undefined while not ready). */
  entry(address: string): DirectoryEntry | null | undefined {
    if (!this.ready) return undefined;
    const e = this.byAddress.get(address.toLowerCase());
    return e && this.isLive(e) ? e : null;
  }

  /** Address whose primary name this is, when the name is live and someone's primary. */
  addressOf(name: string): string | null {
    const a = this.byName.get(name.toLowerCase());
    const e = a ? this.byAddress.get(a) : undefined;
    return a && e && this.isLive(e) ? a : null;
  }

  registratorAddress(): string | null {
    return this.registrator;
  }

  /** After a mint: pull the list again soon, no more than once a minute. */
  refreshSoon(): void {
    const t = this.now();
    if (t - this.lastForced < MIN_FORCED_GAP_MS) return;
    this.lastForced = t;
    this.lastList = 0;
    void this.refresh();
  }

  /** One refresh pass (list if due, then expiries if due). Concurrent calls share it. */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.doRefresh().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private isLive(e: DirectoryEntry): boolean {
    return e.expiry !== null && e.expiry * 1000 > this.now();
  }

  private async doRefresh(): Promise<void> {
    const t = this.now();
    let listChanged = false;
    if (t - this.lastList >= LIST_REFRESH_MS - 5_000) {
      try {
        listChanged = await this.pullList();
        this.lastList = t;
      } catch (error) {
        logDeduplicator.warn('HlNames directory: list refresh failed', { error: error instanceof Error ? error.message : String(error) });
        if (!this.ready) return;
      }
    }
    const missing = [...this.byAddress.values()].some((e) => !this.expiryOf.has(e.namehash));
    if (listChanged || missing || t - this.lastExpiry >= EXPIRY_REFRESH_MS || !this.ready) {
      try {
        await this.pullExpiries();
        this.lastExpiry = t;
      } catch (error) {
        logDeduplicator.warn('HlNames directory: expiry refresh failed', { error: error instanceof Error ? error.message : String(error) });
        // Without expiries the list is not served: an expired name must never show.
        if (!this.ready) return;
      }
    }
    this.ready = true;
  }

  /** Pulls every page (304 keeps the old one). Returns whether anything changed. */
  private async pullList(): Promise<boolean> {
    let changed = false;
    const next: typeof this.pages = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const old = this.pages[p];
      const res = await this.fetchPage(p * PAGE, (p + 1) * PAGE, old?.etag ?? null);
      const page = res.status === 304 && old ? old : res.status === 200 ? { etag: res.etag, rows: res.rows } : null;
      if (!page) throw new Error('304 for a page we never had');
      if (res.status === 200) changed = true;
      next.push(page);
      if (page.rows.length < PAGE) break;
    }
    if (next.length !== this.pages.length) changed = true;
    this.pages = next;
    if (changed) this.rebuild();
    return changed;
  }

  private rebuild(): void {
    const byAddress = new Map<string, DirectoryEntry>();
    const byName = new Map<string, string>();
    for (const page of this.pages) {
      for (const r of page.rows) {
        const address = typeof r.address === 'string' ? r.address.toLowerCase() : '';
        const namehash = typeof r.namehash === 'string' ? r.namehash.toLowerCase() : '';
        const name = typeof r.primaryName === 'string' ? r.primaryName.trim() : '';
        if (!ADDRESS_RE.test(address) || !HASH_RE.test(namehash) || !name.endsWith('.hl') || name.length > 100) continue;
        byAddress.set(address, { name, namehash, expiry: this.expiryOf.get(namehash) ?? null });
        byName.set(name.toLowerCase(), address);
      }
    }
    this.byAddress = byAddress;
    this.byName = byName;
  }

  private async pullExpiries(): Promise<void> {
    this.registrator = await currentRegistrator();
    const hashes = [...new Set([...this.byAddress.values()].map((e) => e.namehash))];
    const values = await expiries(this.registrator, hashes);
    const expiryOf = new Map<string, number | null>();
    hashes.forEach((h, i) => expiryOf.set(h, values[i] ?? null));
    this.expiryOf = expiryOf;
    for (const e of this.byAddress.values()) e.expiry = expiryOf.get(e.namehash) ?? null;
  }
}
