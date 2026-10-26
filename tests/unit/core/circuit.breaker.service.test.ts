/**
 * A caller's refusal (its own budget or throttle is spent) is not an upstream
 * failure: it must neither count towards opening the breaker nor reset it.
 */
import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

let seq = 0;
const freshBreaker = (maxFailures = 5): CircuitBreakerService =>
  CircuitBreakerService.getInstance(`breaker-test-${seq++}`, { maxFailures });

const upstreamFailure = (): Promise<never> => Promise.reject(new Error('upstream down'));
const refusal = (): Promise<never> => Promise.reject(new UpstreamBudgetExceededError(30));

describe('CircuitBreakerService and caller refusals', () => {
  it('stays closed through many refusals and still runs the next call', async () => {
    const breaker = freshBreaker();
    for (let i = 0; i < 10; i++) {
      await expect(breaker.execute(refusal)).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    }
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('rethrows the refusal as is (same instance, so its Retry-After survives)', async () => {
    const breaker = freshBreaker();
    const error = new UpstreamBudgetExceededError(42);
    await expect(breaker.execute(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('does not count refusals together with real failures', async () => {
    const breaker = freshBreaker(5);
    for (let i = 0; i < 4; i++) await breaker.execute(upstreamFailure).catch(() => undefined);
    // Refusals in between neither add to the four failures nor reset them.
    for (let i = 0; i < 10; i++) await breaker.execute(refusal).catch(() => undefined);
    // Still closed: the fifth real failure reaches the operation...
    await expect(breaker.execute(upstreamFailure)).rejects.toThrow('upstream down');
    // ...and it is what opens the breaker.
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow('Circuit breaker is open');
  });

  it('still opens after consecutive real failures', async () => {
    const breaker = freshBreaker(3);
    for (let i = 0; i < 3; i++) await breaker.execute(upstreamFailure).catch(() => undefined);
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow('Circuit breaker is open');
  });
});
