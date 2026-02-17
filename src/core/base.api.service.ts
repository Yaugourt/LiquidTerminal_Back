import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * HTTP API error with status code for granular error handling.
 */
export class HttpApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'HttpApiError';
  }

  /** True for 429, 502, 503, 504 — transient errors worth retrying */
  get isRetryable(): boolean {
    return this.statusCode === 429 || (this.statusCode >= 502 && this.statusCode <= 504);
  }

  /** True for 429 — should use longer backoff */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }
}

export abstract class BaseApiService {
    private readonly API_TIMEOUT = 30000; // 30 secondes au lieu de 5
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 seconde
  
    constructor(
      protected readonly baseUrl: string,
      protected readonly defaultHeaders: Record<string, string> = {
        'Content-Type': 'application/json'
      }
    ) {}
  
    // Méthode principale pour les requêtes avec timeout
    protected async fetchWithTimeout<T>(
      endpoint: string, 
      options: RequestInit
    ): Promise<T> {
      logDeduplicator.info('Making API request', {
        url: `${this.baseUrl}${endpoint}`,
        method: options.method,
        timeout: this.API_TIMEOUT
      });
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.API_TIMEOUT);
  
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.defaultHeaders,
            ...options.headers,
          },
        });
  
        if (!response.ok) {
          const body = await response.text();
          throw new HttpApiError(
            `API error: ${response.status} - ${body}`,
            response.status,
            body
          );
        }

        logDeduplicator.info('API request successful', {
          url: `${this.baseUrl}${endpoint}`,
          status: response.status
        });

        return response.json();
      } catch (error) {
        logDeduplicator.error('API request failed', {
          url: `${this.baseUrl}${endpoint}`,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new Error('Request timeout');
          }
          throw new Error(`API request failed: ${error.message}`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  
    // Méthode pour gérer les retries
    protected async withRetry<T>(
      operation: () => Promise<T>,
      customRetries?: number,
      customDelay?: number
    ): Promise<T> {
      const maxRetries = customRetries ?? this.MAX_RETRIES;
      const delay = customDelay ?? this.RETRY_DELAY;
      let lastError: Error;
  
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error as Error;

          // Don't retry non-retryable HTTP errors (4xx except 429)
          if (error instanceof HttpApiError && !error.isRetryable) {
            throw error;
          }

          if (i < maxRetries - 1) {
            // Use longer backoff for rate limiting
            const backoffMultiplier = (error instanceof HttpApiError && error.isRateLimited) ? 3 : 1;
            const retryDelay = delay * (i + 1) * backoffMultiplier;

            logDeduplicator.warn('API request retry', {
              attempt: i + 1,
              maxRetries,
              service: this.constructor.name,
              statusCode: error instanceof HttpApiError ? error.statusCode : undefined,
              retryDelay,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.delay(retryDelay);
          }
        }
      }
      
      throw lastError!;
    }
  
    // Méthodes HTTP principales
    public async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
      return this.withRetry(() => 
        this.fetchWithTimeout<T>(endpoint, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
    }
  
    public async get<T>(endpoint: string): Promise<T> {
      return this.withRetry(() => 
        this.fetchWithTimeout<T>(endpoint, {
          method: 'GET',
        })
      );
    }
  
    // Utilitaires
    private delay(ms: number): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  
    public handleError(error: unknown): never {
      if (error instanceof Error) {
        throw new Error(`${this.constructor.name} error: ${error.message}`);
      }
      throw new Error(`${this.constructor.name} unknown error`);
    }
  }