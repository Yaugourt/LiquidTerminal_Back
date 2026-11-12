/**
 * A gate's refusal is the caller's own: a cache that runs a loader through a gate must hand it
 * back as it is. Read as a failure of the key, a profile refused once waited for a second turn
 * (twice the wait it was promised), and was computed without being kept.
 */
import { isCallerRefusal } from '../../../src/errors/upstreamBudget.errors';
import { FairGate, GateBusyError } from '../../../src/utils/fairGate';

describe('GateBusyError', () => {
  it('is a caller refusal for the cache and the breakers', () => {
    expect(isCallerRefusal(new GateBusyError())).toBe(true);
    expect(isCallerRefusal(new GateBusyError(3, true))).toBe(true);
    expect(isCallerRefusal(new Error('GATE_BUSY'))).toBe(false);
  });

  it('is what a full gate throws', async () => {
    const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 0, maxWaitingPerClient: 0 });
    let release: () => void = () => undefined;
    const first = gate.run('a', () => new Promise<void>((resolve) => (release = resolve)));
    const refused = await gate.run('b', async () => 1).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GateBusyError);
    expect(isCallerRefusal(refused)).toBe(true);
    release();
    await first;
  });
});
