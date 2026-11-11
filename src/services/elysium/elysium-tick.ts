import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tick a call belongs to: whether it was given up, and when it last moved on. Kept apart
 * from the ingestion service so that what a tick calls (the rollup builder, the daily check)
 * can say "I am still going" without importing it.
 */
export interface TickContext {
  givenUp: boolean;
  /** When the tick last finished a piece of work and started the next one. */
  movedAt: number;
}

export const currentTick = new AsyncLocalStorage<TickContext>();

/** What a tick given up throws at its next step, so that it stops there instead of running beside its successor. */
export class TickGivenUpError extends Error {
  constructor() {
    super('Elysium ingest: tick given up');
    this.name = 'TickGivenUpError';
  }
}

/**
 * Called between two pieces of a tick's work: throws when the tick was given up, and otherwise
 * records that it moved on (its time limit is a time without moving on). Outside a tick it does
 * nothing.
 */
export function tickStep(): void {
  const tick = currentTick.getStore();
  if (!tick) return;
  if (tick.givenUp) throw new TickGivenUpError();
  tick.movedAt = Date.now();
}
