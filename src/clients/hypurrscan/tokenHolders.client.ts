import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RawTokenHolders } from '../../utils/token-holders.util';

export interface HoldersDownloadOptions {
  /** Jumps ahead of the queued downloads and skips the queue limits (one caller: the stakedHYPE table). */
  priority?: boolean;
  /** Checked when the download's turn comes: false skips it (nobody wants the result any more). */
  stillWanted?: () => boolean;
}

/** A download refused or skipped by the queue, before any request to Hypurrscan. */
export class HoldersQueueError extends Error {
  constructor(reason: string) {
    super(`Hypurrscan holders download not run: ${reason}`);
    this.name = 'HoldersQueueError';
  }
}

interface QueuedDownload {
  path: string;
  priority: boolean;
  enqueuedAt: number;
  stillWanted?: () => boolean;
  resolve: (value: RawTokenHolders) => void;
  reject: (error: Error) => void;
}

/**
 * Hypurrscan holder lists, fetched on demand by TokenHoldersService and
 * StakedHoldersService (no polling, nothing stored in Redis). These payloads
 * are huge — HYPE 14.9 MB, stakedHYPE 2.8 MB, USDC ~70 MB (2026-10) — so
 * downloads run one at a time: two parsed lists in memory at once is the peak
 * this process accepts.
 *
 * The queue is bounded so a client cycling through tokens can't pile up
 * downloads: past MAX_QUEUED waiting downloads a new one is refused, and one
 * that waited MAX_WAIT_MS, or whose view was evicted meanwhile, is dropped
 * when its turn comes (its reader gets "holders unavailable"). Priority
 * downloads (the stakedHYPE table, one snapshot) go first and are never
 * refused.
 */
export class HypurrscanTokenHoldersClient extends BaseApiService {
  private static instance: HypurrscanTokenHoldersClient;
  private static readonly API_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';
  /** Regular downloads waiting (the running one excluded): three token views, two lists each. */
  private static readonly MAX_QUEUED = 6;
  /** A regular download that waited this long is dropped: its reader has given up. */
  private static readonly MAX_WAIT_MS = 30_000;

  private readonly circuitBreaker: CircuitBreakerService;
  private readonly waiting: QueuedDownload[] = [];
  private running = false;

  private constructor() {
    super(HypurrscanTokenHoldersClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan_token_holders');
  }

  public static getInstance(): HypurrscanTokenHoldersClient {
    if (!HypurrscanTokenHoldersClient.instance) {
      HypurrscanTokenHoldersClient.instance = new HypurrscanTokenHoldersClient();
    }
    return HypurrscanTokenHoldersClient.instance;
  }

  /** `/holders/{token}` — `{}` for a token Hypurrscan doesn't know. */
  public getHolders(token: string, options: HoldersDownloadOptions = {}): Promise<RawTokenHolders> {
    return this.enqueue(`/holders/${encodeURIComponent(token)}`, options);
  }

  /** `/holders/staked{token}` — `{}` for a token nobody stakes. */
  public getStakedHolders(token: string, options: HoldersDownloadOptions = {}): Promise<RawTokenHolders> {
    return this.enqueue(`/holders/staked${encodeURIComponent(token)}`, options);
  }

  /** Free slots for regular downloads (a token view needs two). */
  public freeSlots(): number {
    const queued = this.waiting.filter((d) => !d.priority).length;
    return Math.max(0, HypurrscanTokenHoldersClient.MAX_QUEUED - queued);
  }

  private enqueue(path: string, { priority = false, stillWanted }: HoldersDownloadOptions): Promise<RawTokenHolders> {
    if (!priority && this.freeSlots() === 0) {
      return Promise.reject(new HoldersQueueError('queue full'));
    }
    return new Promise<RawTokenHolders>((resolve, reject) => {
      const download: QueuedDownload = { path, priority, enqueuedAt: Date.now(), stillWanted, resolve, reject };
      if (priority) {
        // After the other priority downloads, before every regular one.
        const firstRegular = this.waiting.findIndex((d) => !d.priority);
        this.waiting.splice(firstRegular === -1 ? this.waiting.length : firstRegular, 0, download);
      } else {
        this.waiting.push(download);
      }
      void this.drain();
    });
  }

  /** Runs the waiting downloads one at a time. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let download: QueuedDownload | undefined;
      while ((download = this.waiting.shift())) {
        if (!download.priority && Date.now() - download.enqueuedAt > HypurrscanTokenHoldersClient.MAX_WAIT_MS) {
          download.reject(new HoldersQueueError('waited too long'));
          continue;
        }
        if (download.stillWanted && !download.stillWanted()) {
          download.reject(new HoldersQueueError('no longer wanted'));
          continue;
        }
        const path = download.path;
        try {
          download.resolve(await this.circuitBreaker.execute(() => this.get<RawTokenHolders>(path)));
        } catch (error) {
          download.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
