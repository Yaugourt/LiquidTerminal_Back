export class SSEError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'SSE_ERROR') {
    super(message);
    this.name = 'SSEError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class SSEConnectionLimitError extends SSEError {
  constructor(message: string = 'Maximum SSE connections reached') {
    super(message, 429, 'SSE_CONNECTION_LIMIT');
    this.name = 'SSEConnectionLimitError';
  }
}

export class SSERateLimitError extends SSEError {
  constructor(message: string = 'SSE rate limit exceeded') {
    super(message, 429, 'SSE_RATE_LIMIT');
    this.name = 'SSERateLimitError';
  }
}
