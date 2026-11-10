import { logDeduplicator } from '../../utils/logDeduplicator';
import { positiveIntEnv } from '../../utils/env';

/**
 * The proxy has no room for this request right now: too many forwards in
 * flight, or the minute's budget of calls to the archive node is spent. The
 * caller is told when to come back.
 */
export class ElysiumRpcBusyError extends Error {
  constructor(public readonly retryAfterS: number) {
    super('ELYSIUM_MAINNET_RPC_BUSY');
    this.name = 'ElysiumRpcBusyError';
  }
}

/** The archive node's answer is larger than the proxy relays. */
export class ElysiumRpcResponseTooLargeError extends Error {
  constructor() {
    super('ELYSIUM_MAINNET_RPC_RESPONSE_TOO_LARGE');
    this.name = 'ElysiumRpcResponseTooLargeError';
  }
}

/**
 * Forwards read-only JSON-RPC calls to the Elysium mainnet archive RPC.
 *
 * The archive RPC is keyed (the key is in its URL), so it can never be read
 * from the browser: the builder tools (Simulator, Decoder, Network, Tx
 * inspector) call this proxy instead, and the key stays in ELYSIUM_MAINNET_RPC_URL
 * on the server. The route (elysium-rpc.routes.ts) only lets allowlisted
 * read-only methods through; this service just forwards and never logs the URL.
 *
 * The key is one for everyone, so these ceilings stand between a flood and
 * the node, behind the per-client rate limit of the route:
 * - forwards in flight, in all (`ELYSIUM_RPC_MAX_IN_FLIGHT`) and per client
 *   (`ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT`): each holds a socket and its
 *   answer in memory for up to the timeout. The per-client share is what keeps
 *   one client's slow calls from taking every slot from the others;
 * - calls a minute across all clients (`ELYSIUM_RPC_GLOBAL_PER_MINUTE`), per
 *   process: many IPs together still cannot spend the key's quota;
 * - bytes of one answer (`ELYSIUM_RPC_MAX_RESPONSE_BYTES`): the body is read
 *   up to that size and relayed as text, never parsed here.
 */
export class ElysiumRpcProxyService {
  private static instance: ElysiumRpcProxyService;
  /** One call plus every redirect/read hop; the archive RPC answers well under this. */
  private readonly TIMEOUT_MS = 15_000;
  /** A wide `eth_getLogs` (10,000 logs) or a full block of receipts is 3 to 5 MB. */
  private readonly maxResponseBytes = positiveIntEnv('ELYSIUM_RPC_MAX_RESPONSE_BYTES', 8 * 1024 * 1024);
  private readonly maxInFlight = positiveIntEnv('ELYSIUM_RPC_MAX_IN_FLIGHT', 64);
  /** Opening a tool fires about 7 to 15 calls together (see elysiumRpcRateLimiter): room for one such page load, a quarter of the total. */
  private readonly maxInFlightPerClient = positiveIntEnv('ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT', 16);
  /** 200 calls a second across all clients, ten times one client's own ceiling. */
  private readonly globalPerMinute = positiveIntEnv('ELYSIUM_RPC_GLOBAL_PER_MINUTE', 12_000);

  private inFlight = 0;
  /** Forwards in flight per client key; an entry is removed when it reaches 0. */
  private readonly inFlightByClient = new Map<string, number>();
  /** Calls forwarded in the current fixed minute. */
  private minute = { index: 0, calls: 0 };

  public static getInstance(): ElysiumRpcProxyService {
    if (!ElysiumRpcProxyService.instance) {
      ElysiumRpcProxyService.instance = new ElysiumRpcProxyService();
    }
    return ElysiumRpcProxyService.instance;
  }

  /** The keyed mainnet RPC URL, or null when it is not configured. */
  private url(): string | null {
    const u = process.env.ELYSIUM_MAINNET_RPC_URL?.trim();
    return u ? u : null;
  }

  public isConfigured(): boolean {
    return this.url() !== null;
  }

  /** Takes `calls` from the minute's budget, or throws with the wait until the minute rolls over. */
  private spend(calls: number): void {
    const now = Date.now();
    const index = Math.floor(now / 60_000);
    if (this.minute.index !== index) this.minute = { index, calls: 0 };
    if (this.minute.calls + calls > this.globalPerMinute) {
      logDeduplicator.warn('Elysium RPC proxy: global minute budget spent', { budget: this.globalPerMinute });
      throw new ElysiumRpcBusyError(Math.max(1, 60 - Math.floor((now % 60_000) / 1000)));
    }
    this.minute.calls += calls;
  }

  /** The body as text, read no further than the ceiling. */
  private async readCapped(res: Response): Promise<string> {
    const tooLarge = (): ElysiumRpcResponseTooLargeError => {
      logDeduplicator.warn('Elysium RPC proxy: upstream answer over the size ceiling', {
        maxBytes: this.maxResponseBytes,
      });
      return new ElysiumRpcResponseTooLargeError();
    };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      // Free the connection rather than leave the unread body on it.
      void res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  /**
   * Forwards a validated JSON-RPC body (one call or a batch of `calls`) for
   * `client` (its rate-limit key) and returns the upstream JSON-RPC response
   * as received, unparsed: the answer can be megabytes, and parsing then
   * re-serialising it would hold the event loop for nothing. Throws
   * ElysiumRpcBusyError / ElysiumRpcResponseTooLargeError for the ceilings
   * above, a plain Error on a transport or upstream failure; no error ever
   * carries the keyed URL.
   */
  public async forward(body: unknown, calls = 1, client = ''): Promise<string> {
    const url = this.url();
    if (!url) throw new Error('ELYSIUM_MAINNET_RPC_NOT_CONFIGURED');

    const mine = this.inFlightByClient.get(client) ?? 0;
    // The client's own share first: its refusal is its own doing and is not logged as a shortage.
    if (mine >= this.maxInFlightPerClient) throw new ElysiumRpcBusyError(1);
    if (this.inFlight >= this.maxInFlight) {
      logDeduplicator.warn('Elysium RPC proxy: too many forwards in flight', { max: this.maxInFlight });
      throw new ElysiumRpcBusyError(1);
    }
    this.spend(calls);

    this.inFlight += 1;
    this.inFlightByClient.set(client, mine + 1);
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // Covers the body too: the signal stays on the response stream.
          signal: AbortSignal.timeout(this.TIMEOUT_MS),
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          logDeduplicator.warn('Elysium RPC proxy upstream status', { status: res.status });
          throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
        }
        text = await this.readCapped(res);
      } catch (error) {
        if (error instanceof ElysiumRpcResponseTooLargeError) throw error;
        if (error instanceof Error && error.message === 'ELYSIUM_MAINNET_RPC_UPSTREAM') throw error;
        // Keep the URL out of the message: it carries the key.
        logDeduplicator.warn('Elysium RPC proxy transport error', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        throw new Error('ELYSIUM_MAINNET_RPC_TRANSPORT');
      }
      // A JSON-RPC answer is an object or an array; anything else (an HTML
      // error page behind a 200) must not reach the client as JSON.
      if (!/^\s*[[{]/.test(text)) {
        logDeduplicator.warn('Elysium RPC proxy: upstream answer is not JSON-RPC');
        throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
      }
      return text;
    } finally {
      this.inFlight -= 1;
      const left = (this.inFlightByClient.get(client) ?? 1) - 1;
      if (left <= 0) this.inFlightByClient.delete(client);
      else this.inFlightByClient.set(client, left);
    }
  }
}
