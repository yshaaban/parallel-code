import { describe, expect, it, vi } from 'vitest';

import {
  runIndependentCleanups,
  runOperationWithCleanups,
} from '../../scripts/lib/cleanup-outcome.mjs';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('cleanup outcome aggregation', () => {
  it('starts every independent cleanup, waits for late settlement, and labels arbitrary failures', async () => {
    const lateCleanup = createDeferred<undefined>();
    const firstCleanup = vi.fn(() => {
      throw undefined;
    });
    const secondCleanup = vi.fn(() => lateCleanup.promise);
    const thirdCleanup = vi.fn(() => Promise.reject(null));
    let settled = false;
    const outcome = runIndependentCleanups('Fixture owners', [
      ['release first owner', firstCleanup],
      ['release late owner', secondCleanup],
      ['release third owner', thirdCleanup],
    ])
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(thirdCleanup).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    lateCleanup.reject('late cleanup failed');
    const failure = await outcome;

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Fixture owners cleanup failed');
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ cause: undefined, message: 'release first owner: undefined' }),
      expect.objectContaining({
        cause: 'late cleanup failed',
        message: 'release late owner: late cleanup failed',
      }),
      expect.objectContaining({ cause: null, message: 'release third owner: null' }),
    ]);
  });

  it('preserves arbitrary operation and cleanup rejection values together', async () => {
    const failure = await runOperationWithCleanups('Fixture', () => Promise.reject(undefined), [
      ['release fixture', () => Promise.reject(null)],
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Fixture operation and cleanup failed');
    expect((failure as AggregateError).errors).toEqual([
      undefined,
      expect.objectContaining({ cause: null, message: 'release fixture: null' }),
    ]);
  });
});
