/** The gate has no room for this caller right now; it is told when to come back. */
export class GateBusyError extends Error {
  constructor(
    public readonly retryAfterS = 1,
    /** True when the caller is over its own share, false when the gate as a whole is full. */
    public readonly ownShare = false
  ) {
    super('GATE_BUSY');
    this.name = 'GateBusyError';
  }
}

export interface FairGateOptions {
  /** Runs at once, all clients together. */
  max: number;
  /** Runs at once for one client: its share of `max`. */
  maxPerClient: number;
  /** Callers waiting for a turn, all clients together. */
  maxWaiting: number;
  /** Callers of one client waiting for a turn. */
  maxWaitingPerClient: number;
  /**
   * When a client already has `maxWaitingPerClient` callers waiting: refuse
   * the newcomer (default), or let it take the place of that client's oldest
   * waiter, which is refused instead (a search box: only the last text matters).
   */
  whenClientQueueFull?: 'refuse' | 'replace-oldest';
  /** A caller that has waited this long is refused. */
  maxWaitMs?: number;
}

interface Waiter {
  client: string;
  start: () => void;
  refuse: (error: GateBusyError) => void;
  timer?: NodeJS.Timeout;
}

/**
 * A shared ceiling with a share per client.
 *
 * A plain ceiling ("N at once, M waiting") is taken whole by whoever asks
 * fastest: one client fills the slots and the queue, and everyone else is
 * refused. Here a client runs at most `maxPerClient` at once and keeps at most
 * `maxWaitingPerClient` waiting; a free slot goes to the waiting client that
 * has the fewest running, then to the one served longest ago, then to the
 * oldest waiter. So a client that floods only delays itself.
 *
 * In memory, per process: it protects what this process holds (connections of
 * a pool, sockets, memory).
 */
export class FairGate {
  private running = 0;
  private readonly runningBy = new Map<string, number>();
  private readonly waitingBy = new Map<string, number>();
  /** Order of each client's last start; kept only while the client runs or waits. */
  private readonly lastStartBy = new Map<string, number>();
  private starts = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: FairGateOptions) {}

  /** Runs `fn` when the gate and the client's share have room; rejects with GateBusyError otherwise. */
  public async run<T>(client: string, fn: () => Promise<T>): Promise<T> {
    await this.enter(client);
    try {
      return await fn();
    } finally {
      this.leave(client);
    }
  }

  /** Runs in flight and callers waiting (diagnostics, tests). */
  public get stats(): { running: number; waiting: number; clients: number } {
    return { running: this.running, waiting: this.queue.length, clients: this.runningBy.size };
  }

  private canStart(client: string): boolean {
    return this.running < this.options.max && (this.runningBy.get(client) ?? 0) < this.options.maxPerClient;
  }

  private start(client: string): void {
    this.running += 1;
    this.runningBy.set(client, (this.runningBy.get(client) ?? 0) + 1);
    this.starts += 1;
    this.lastStartBy.set(client, this.starts);
  }

  /** Drops what is remembered of a client that neither runs nor waits. */
  private forgetIfIdle(client: string): void {
    if (!this.runningBy.has(client) && !this.waitingBy.has(client)) this.lastStartBy.delete(client);
  }

  private enter(client: string): Promise<void> {
    if (this.canStart(client)) {
      this.start(client);
      return Promise.resolve();
    }
    const waiting = this.waitingBy.get(client) ?? 0;
    if (waiting >= this.options.maxWaitingPerClient) {
      const oldest = this.options.whenClientQueueFull === 'replace-oldest' ? this.queue.findIndex((w) => w.client === client) : -1;
      if (oldest < 0) return Promise.reject(new GateBusyError(1, true));
      this.remove(oldest).refuse(new GateBusyError(1, true));
    } else if (this.queue.length >= this.options.maxWaiting) {
      return Promise.reject(new GateBusyError(1, false));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { client, start: resolve, refuse: reject };
      if (this.options.maxWaitMs) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.remove(index).refuse(new GateBusyError(1, false));
        }, this.options.maxWaitMs);
        waiter.timer.unref();
      }
      this.queue.push(waiter);
      this.waitingBy.set(client, (this.waitingBy.get(client) ?? 0) + 1);
    });
  }

  /** Takes the waiter at `index` out of the queue. */
  private remove(index: number): Waiter {
    const [waiter] = this.queue.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    const left = (this.waitingBy.get(waiter.client) ?? 1) - 1;
    if (left <= 0) this.waitingBy.delete(waiter.client);
    else this.waitingBy.set(waiter.client, left);
    this.forgetIfIdle(waiter.client);
    return waiter;
  }

  private leave(client: string): void {
    this.running -= 1;
    const left = (this.runningBy.get(client) ?? 1) - 1;
    if (left <= 0) this.runningBy.delete(client);
    else this.runningBy.set(client, left);
    this.forgetIfIdle(client);

    // Hand the free slots over: fewest running first, then served longest ago, then the oldest waiter.
    while (this.running < this.options.max) {
      let pick = -1;
      let pickRunning = Infinity;
      let pickLastStart = Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const waiter = this.queue[i].client;
        const running = this.runningBy.get(waiter) ?? 0;
        if (running >= this.options.maxPerClient) continue;
        const lastStart = this.lastStartBy.get(waiter) ?? 0;
        if (running < pickRunning || (running === pickRunning && lastStart < pickLastStart)) {
          pick = i;
          pickRunning = running;
          pickLastStart = lastStart;
        }
      }
      if (pick < 0) return;
      const waiter = this.remove(pick);
      this.start(waiter.client);
      waiter.start();
    }
  }
}
