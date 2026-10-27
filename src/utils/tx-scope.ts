import { AsyncLocalStorage } from 'async_hooks';

/**
 * Which Prisma client each repository uses inside the transaction being run.
 *
 * Repositories are module singletons shared by every request. Swapping a
 * transaction client onto the singleton (and back) leaked it to other requests
 * running at the same time, and stayed there, closed, when the block threw
 * before the swap back. The binding lives in the async context of the
 * transaction body instead: it follows that body's awaits, is invisible to any
 * other request, and ends with the body whether it resolved or threw.
 *
 * Binding is per repository INSTANCE and explicit: only the repositories a call
 * site lists join the transaction, no matter which database they point at.
 *
 * Anything started inside the body inherits the binding for good (a timer, a
 * cache loader, a fire-and-forget promise) and would then run on a closed
 * transaction: start nothing there that outlives the transaction.
 */
const storage = new AsyncLocalStorage<ReadonlyMap<object, unknown>>();

/**
 * Runs `fn` with each repository of `repos` bound to the transaction client
 * `tx`. Scopes nest: the inner one inherits the outer bindings and overrides
 * those it lists again.
 */
export function runWithTx<T>(tx: unknown, repos: readonly object[], fn: () => Promise<T>): Promise<T> {
  const bindings = new Map<object, unknown>(storage.getStore());
  for (const repo of repos) {
    bindings.set(repo, tx);
  }
  return storage.run(bindings, fn);
}

/** The transaction client bound to this repository in the current async context, or undefined outside one. */
export function scopedClient<C>(repo: object): C | undefined {
  return storage.getStore()?.get(repo) as C | undefined;
}
