import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Forwards read-only JSON-RPC calls to the Elysium mainnet archive RPC.
 *
 * The archive RPC is keyed (the key is in its URL), so it can never be read
 * from the browser: the builder tools (Simulator, Decoder, Network, Tx
 * inspector) call this proxy instead, and the key stays in ELYSIUM_MAINNET_RPC_URL
 * on the server. The route (elysium-rpc.routes.ts) only lets allowlisted
 * read-only methods through; this service just forwards and never logs the URL.
 */
export class ElysiumRpcProxyService {
  private static instance: ElysiumRpcProxyService;
  /** One call plus every redirect/read hop; the archive RPC answers well under this. */
  private readonly TIMEOUT_MS = 15_000;

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

  /**
   * Forwards a validated JSON-RPC body (one call or a batch) and returns the
   * upstream JSON-RPC response verbatim. Throws on a transport/upstream failure;
   * the error never carries the keyed URL.
   */
  public async forward(body: unknown): Promise<unknown> {
    const url = this.url();
    if (!url) throw new Error('ELYSIUM_MAINNET_RPC_NOT_CONFIGURED');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.TIMEOUT_MS),
      });
    } catch (error) {
      // Keep the URL out of the message: it carries the key.
      logDeduplicator.warn('Elysium RPC proxy transport error', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new Error('ELYSIUM_MAINNET_RPC_TRANSPORT');
    }

    if (!res.ok) {
      logDeduplicator.warn('Elysium RPC proxy upstream status', { status: res.status });
      throw new Error('ELYSIUM_MAINNET_RPC_UPSTREAM');
    }
    return res.json();
  }
}
