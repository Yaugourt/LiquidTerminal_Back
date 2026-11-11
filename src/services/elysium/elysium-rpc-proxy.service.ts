import type { ServerResponse } from 'http';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { positiveIntEnv } from '../../utils/env';
import { cleanRpcErrors, holdsSecret, RPC_ERROR_CLEAN_MAX_BYTES, rpcSecrets } from './elysium-rpc-errors';
import { FairGate, GateBusyError } from '../../utils/fairGate';

/**
 * The proxy has no room for this request right now: its client's share or the
 * proxy as a whole is taken (forwards in flight, memory held), or the minute's
 * budget of calls to the archive node is spent. The caller is told when to
 * come back.
 */
export class ElysiumRpcBusyError extends Error {
  constructor(public readonly retryAfterS: number) {
    super('ELYSIUM_MAINNET_RPC_BUSY');
    this.name = 'ElysiumRpcBusyError';
  }
}

/** The client went away before its answer was ready: there is nobody to answer. */
export class ElysiumRpcClientGoneError extends Error {
  constructor() {
    super('ELYSIUM_MAINNET_RPC_CLIENT_GONE');
    this.name = 'ElysiumRpcClientGoneError';
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
 * The node's answer, as received. It holds a forward slot and its bytes in the
 * proxy's memory budget until `release` is called: once the client has it, or
 * is gone (`deliver` does it).
 */
export interface ElysiumRpcAnswer {
  chunks: Buffer[];
  bytes: number;
  /** Frees the slot and the memory this answer holds. Calling it twice is harmless. */
  release(): void;
}

/** The longest an answer waits to be read by its client before the response is cut. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** The longest a call waits for a slot of its client's share. */
const SLOT_WAIT_MS = 5_000;

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
 * the node, behind the per-client rate limit of the route. Each has a share
 * per client (its IP, or /64): a ceiling without one is taken whole by the
 * client that asks fastest.
 * - forwards in flight, in all (`ELYSIUM_RPC_MAX_IN_FLIGHT`) and per client
 *   (`ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT`): each holds a socket for up to
 *   the timeout. A client past its share waits for one of its own calls to
 *   end (up to 32 of them, 5 s), it is not refused: opening a tool fires more
 *   calls at once than the share;
 * - bytes of answers held in memory, in all (`ELYSIUM_RPC_MAX_BUFFERED_BYTES`)
 *   and per client (`ELYSIUM_RPC_MAX_BUFFERED_BYTES_PER_CLIENT`), from the
 *   first byte read to the moment the client has the answer: an answer can be
 *   megabytes, and a client that does not read holds it;
 * - weight of the calls of a minute across all clients
 *   (`ELYSIUM_RPC_GLOBAL_PER_MINUTE`), per process: many IPs together still
 *   cannot spend the key's quota;
 * - bytes of one answer (`ELYSIUM_RPC_MAX_RESPONSE_BYTES`): the body is read
 *   up to that size and relayed as received, never decoded or parsed here,
 *   except a small answer that carries an error: the node's own wording is
 *   cleaned before it leaves (see elysium-rpc-errors).
 */
export class ElysiumRpcProxyService {
  private static instance: ElysiumRpcProxyService;
  /** One call plus every redirect/read hop; the archive RPC answers well under this. */
  private readonly TIMEOUT_MS = 15_000;
  /** A wide `eth_getLogs` (10,000 logs) or a full block of receipts is 3 to 5 MB. */
  private readonly maxResponseBytes = positiveIntEnv('ELYSIUM_RPC_MAX_RESPONSE_BYTES', 8 * 1024 * 1024);
  private readonly maxInFlight = positiveIntEnv('ELYSIUM_RPC_MAX_IN_FLIGHT', 64);
  /** An eighth of the total: eight clients with slow calls are needed to take every slot, where four were. */
  private readonly maxInFlightPerClient = positiveIntEnv('ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT', 8);
  /** Twelve answers of the largest size, in all; three of them for one client. */
  private readonly maxBufferedBytes = positiveIntEnv('ELYSIUM_RPC_MAX_BUFFERED_BYTES', 96 * 1024 * 1024);
  private readonly maxBufferedBytesPerClient = positiveIntEnv('ELYSIUM_RPC_MAX_BUFFERED_BYTES_PER_CLIENT', 24 * 1024 * 1024);
  /** 200 units a second across all clients, ten times one client's own ceiling. */
  private readonly globalPerMinute = positiveIntEnv('ELYSIUM_RPC_GLOBAL_PER_MINUTE', 12_000);

  private readonly gate = new FairGate({
    max: this.maxInFlight,
    maxPerClient: this.maxInFlightPerClient,
    maxWaiting: positiveIntEnv('ELYSIUM_RPC_MAX_WAITING', 256),
    maxWaitingPerClient: positiveIntEnv('ELYSIUM_RPC_MAX_WAITING_PER_CLIENT', 32),
    maxWaitMs: SLOT_WAIT_MS,
  });
  /** Bytes of answers held (being read, or waiting for their client), in all and per client key. */
  private buffered = 0;
  private readonly bufferedByClient = new Map<string, number>();
  /** Weight forwarded in the current fixed minute. */
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

  /** Forwards in flight (waiting for the node or for their client) and bytes held: diagnostics and tests. */
  public get load(): { inFlight: number; waiting: number; bufferedBytes: number; clients: number } {
    const { running, waiting } = this.gate.stats;
    return { inFlight: running, waiting, bufferedBytes: this.buffered, clients: this.bufferedByClient.size };
  }

  /** Takes `weight` from the minute's budget, or throws with the wait until the minute rolls over. */
  private spend(weight: number): void {
    const now = Date.now();
    const index = Math.floor(now / 60_000);
    if (this.minute.index !== index) this.minute = { index, calls: 0 };
    if (this.minute.calls + weight > this.globalPerMinute) {
      logDeduplicator.warn('Elysium RPC proxy: global minute budget spent', { budget: this.globalPerMinute });
      throw new ElysiumRpcBusyError(Math.max(1, 60 - Math.floor((now % 60_000) / 1000)));
    }
    this.minute.calls += weight;
  }

  /** Counts `bytes` more held for `client`, or throws when its share or the proxy's memory budget is full. */
  private hold(client: string, bytes: number): void {
    const mine = this.bufferedByClient.get(client) ?? 0;
    // The client's own share first: its refusal is its own doing and is not logged as a shortage.
    if (mine + bytes > this.maxBufferedBytesPerClient) throw new ElysiumRpcBusyError(1);
    if (this.buffered + bytes > this.maxBufferedBytes) {
      logDeduplicator.warn('Elysium RPC proxy: answers held in memory at the ceiling', { maxBytes: this.maxBufferedBytes });
      throw new ElysiumRpcBusyError(1);
    }
    this.buffered += bytes;
    this.bufferedByClient.set(client, mine + bytes);
  }

  private unhold(client: string, bytes: number): void {
    this.buffered -= bytes;
    const left = (this.bufferedByClient.get(client) ?? bytes) - bytes;
    if (left <= 0) this.bufferedByClient.delete(client);
    else this.bufferedByClient.set(client, left);
  }

  /** The body's chunks, read no further than the ceiling, each counted against `client` as it arrives. */
  private async readCapped(res: Response, client: string, held: { bytes: number }): Promise<Buffer[]> {
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
    if (!res.body) return [];
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (held.bytes + value.byteLength > this.maxResponseBytes) throw tooLarge();
        this.hold(client, value.byteLength);
        held.bytes += value.byteLength;
        // A view on the same memory, not a copy.
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    return chunks;
  }

  /** True when the first byte that is not white space opens a JSON object or array. */
  private static looksLikeJsonRpc(chunks: Buffer[]): boolean {
    for (const chunk of chunks) {
      for (const byte of chunk) {
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
        return byte === 0x5b || byte === 0x7b;
      }
    }
    return false;
  }

  /**
   * Forwards a validated JSON-RPC body (one call or a batch, weighing `weight`)
   * for `client` (its rate-limit key) and returns the upstream JSON-RPC
   * response as received, undecoded: the answer can be megabytes, and decoding,
   * parsing or re-serialising it would hold the event loop for nothing. The
   * answer keeps its slot and its bytes until it is released (see `deliver`).
   * Throws ElysiumRpcBusyError / ElysiumRpcResponseTooLargeError for the
   * ceilings above, a plain Error on a transport or upstream failure; no error
   * ever carries the keyed URL.
   *
   * `gone` aborts when the client's connection closes: a call still waiting
   * for a slot is then not sent, and one at the node is cut, with
   * ElysiumRpcClientGoneError. Nothing is held for a client that left.
   */
  public async forward(body: unknown, weight = 1, client = '', gone?: AbortSignal): Promise<ElysiumRpcAnswer> {
    const url = this.url();
    if (!url) throw new Error('ELYSIUM_MAINNET_RPC_NOT_CONFIGURED');
    if (gone?.aborted) throw new ElysiumRpcClientGoneError();

    let freeSlot: () => void;
    try {
      freeSlot = await this.gate.acquire(client);
    } catch (error) {
      if (!(error instanceof GateBusyError)) throw error;
      // The client's own share is its own doing; only a shortage of the proxy is logged.
      if (!error.ownShare) logDeduplicator.warn('Elysium RPC proxy: too many forwards in flight', { max: this.maxInFlight });
      throw new ElysiumRpcBusyError(error.retryAfterS);
    }
    const held = { bytes: 0 };
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      freeSlot();
      this.unhold(client, held.bytes);
    };

    try {
      // It left while it waited for the slot: no call to the node, nothing spent.
      if (gone?.aborted) throw new ElysiumRpcClientGoneError();
      this.spend(weight);
      let res: Response;
      let chunks: Buffer[];
      try {
        const timeout = AbortSignal.timeout(this.TIMEOUT_MS);
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // Covers the body too: the signal stays on the response stream.
          signal: gone ? AbortSignal.any([timeout, gone]) : timeout,
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          logDeduplicator.warn('Elysium RPC proxy upstream status', { status: res.status });
          throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
        }
        chunks = await this.readCapped(res, client, held);
      } catch (error) {
        if (error instanceof ElysiumRpcResponseTooLargeError || error instanceof ElysiumRpcBusyError) throw error;
        if (error instanceof Error && error.message === 'ELYSIUM_MAINNET_RPC_UPSTREAM') throw error;
        // Cut because the client left, not a failure of the node.
        if (gone?.aborted) throw new ElysiumRpcClientGoneError();
        // Keep the URL out of the message: it carries the key.
        logDeduplicator.warn('Elysium RPC proxy transport error', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        throw new Error('ELYSIUM_MAINNET_RPC_TRANSPORT');
      }
      // A JSON-RPC answer is an object or an array; anything else (an HTML
      // error page behind a 200) must not reach the client as JSON.
      if (!ElysiumRpcProxyService.looksLikeJsonRpc(chunks)) {
        logDeduplicator.warn('Elysium RPC proxy: upstream answer is not JSON-RPC');
        throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
      }
      // The node's own error messages are not relayed as written (see elysium-rpc-errors). An
      // answer that carries an error is small: it is read and its errors rewritten. A large one
      // is results, and is only checked for the key before it leaves.
      const secrets = rpcSecrets(url);
      if (held.bytes <= RPC_ERROR_CLEAN_MAX_BYTES) {
        const cleaned = cleanRpcErrors(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), secrets);
        if (cleaned) {
          const delta = cleaned.byteLength - held.bytes;
          if (delta > 0) this.hold(client, delta);
          else this.unhold(client, -delta);
          held.bytes = cleaned.byteLength;
          chunks = [cleaned];
        }
      } else if (holdsSecret(chunks, secrets)) {
        logDeduplicator.warn('Elysium RPC proxy: upstream answer quotes the node\'s address, not relayed');
        throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
      }
      return { chunks, bytes: held.bytes, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Writes `answer` to `res` as the JSON it is, and releases it when the
   * client has it or has gone. A client that has not read it after
   * DELIVERY_TIMEOUT_MS is cut: the bytes of an unread answer sit in this
   * process, and a slot of its client's share with them.
   *
   * The release never rests on an event alone: a response that is already
   * closed when this is called (the client left while the node was answering)
   * emits no further 'close', so it is released here, and the timeout releases
   * whatever the events did not.
   */
  public deliver(answer: ElysiumRpcAnswer, res: ServerResponse): void {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
      answer.release();
      return;
    }
    const timer = setTimeout(() => {
      logDeduplicator.warn('Elysium RPC proxy: client did not read its answer, connection cut');
      res.destroy();
      answer.release();
    }, DELIVERY_TIMEOUT_MS);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      answer.release();
    };
    // 'finish': everything was handed to the socket. 'close': the client went away first.
    res.once('finish', done);
    res.once('close', done);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(answer.bytes));
    for (const chunk of answer.chunks) res.write(chunk);
    res.end();
  }
}
