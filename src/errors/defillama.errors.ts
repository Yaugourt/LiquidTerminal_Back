/**
 * DefiLlama proxy errors. Mirrors the plain-Error + statusCode + code pattern
 * used across the codebase (see project.errors.ts).
 */
export class DefiLlamaError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode = 502, code = 'DEFILLAMA_ERROR') {
    super(message);
    this.name = 'DefiLlamaError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Upstream answered 400/404: the protocol slug is unknown to DefiLlama or the
 * protocol has no module of that kind (e.g. no DEX volume for a lending market).
 */
export class DefiLlamaNotFoundError extends DefiLlamaError {
  constructor(message = 'Protocol not tracked by DefiLlama') {
    super(message, 404, 'DEFILLAMA_NOT_FOUND');
  }
}

/** Upstream failed transiently or returned an unexpected status. */
export class DefiLlamaUpstreamError extends DefiLlamaError {
  constructor(message = 'DefiLlama upstream error') {
    super(message, 502, 'DEFILLAMA_UPSTREAM_ERROR');
  }
}
