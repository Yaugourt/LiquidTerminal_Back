interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  isOpen: boolean;
}

/** Optional tuning for a named circuit; applied only on first `getInstance` for that name. */
export interface CircuitBreakerOptions {
  maxFailures?: number;
  resetTimeout?: number;
  circuitBreakerTimeout?: number;
}

export class CircuitBreakerService {
  private static instances = new Map<string, CircuitBreakerService>();
  private state: CircuitBreakerState;
  private readonly maxFailures: number;
  private readonly resetTimeout: number;
  private readonly circuitBreakerTimeout: number;

  private constructor(
    maxFailures: number = 5,
    resetTimeout: number = 60000, // 1 minute
    circuitBreakerTimeout: number = 30000 // 30 seconds
  ) {
    this.maxFailures = maxFailures;
    this.resetTimeout = resetTimeout;
    this.circuitBreakerTimeout = circuitBreakerTimeout;
    this.state = {
      failures: 0,
      lastFailureTime: 0,
      isOpen: false
    };
  }

  public static getInstance(serviceName: string, options?: CircuitBreakerOptions): CircuitBreakerService {
    if (!CircuitBreakerService.instances.has(serviceName)) {
      const instance = new CircuitBreakerService(
        options?.maxFailures ?? 5,
        options?.resetTimeout ?? 60000,
        options?.circuitBreakerTimeout ?? 30000
      );
      CircuitBreakerService.instances.set(serviceName, instance);
    }
    return CircuitBreakerService.instances.get(serviceName)!;
  }

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!await this.checkCircuitBreaker()) {
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await operation();
      this.handleSuccess();
      return result;
    } catch (error) {
      this.handleFailure();
      throw error;
    }
  }

  private async checkCircuitBreaker(): Promise<boolean> {
    if (!this.state.isOpen) {
      return true;
    }

    const now = Date.now();
    if (now - this.state.lastFailureTime > this.circuitBreakerTimeout) {
      this.state.isOpen = false;
      this.state.failures = 0;
      return true;
    }

    return false;
  }

  private handleFailure(): void {
    this.state.failures++;
    this.state.lastFailureTime = Date.now();
    
    if (this.state.failures >= this.maxFailures) {
      this.state.isOpen = true;
    }
  }

  private handleSuccess(): void {
    this.state.failures = 0;
  }
} 