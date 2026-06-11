import { describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';
import type { IpcHandlerMap } from './handlers.js';
import { createLazyIpcHandlerGroup } from './lazy-handler-group.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

describe('createLazyIpcHandlerGroup', () => {
  it('loads once and shares the load across concurrent first calls', async () => {
    const handler = vi.fn((args?: Record<string, unknown>) => ({ echoed: args }));
    const load = vi.fn(
      async (): Promise<IpcHandlerMap> => ({
        [IPC.CoordinatorGetDiagnostics]: handler,
      }),
    );
    const group = createLazyIpcHandlerGroup([IPC.CoordinatorGetDiagnostics], load);

    const lazyHandler = group[IPC.CoordinatorGetDiagnostics];
    expect(lazyHandler).toBeDefined();
    expect(load).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      lazyHandler?.({ callId: 'one' }),
      lazyHandler?.({ callId: 'two' }),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ echoed: { callId: 'one' } });
    expect(second).toEqual({ echoed: { callId: 'two' } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects in-flight calls on load failure and retries on the next call', async () => {
    const deferred = createDeferred<IpcHandlerMap>();
    const load = vi
      .fn<() => Promise<IpcHandlerMap>>()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue({ [IPC.CoordinatorGetDiagnostics]: () => 'recovered' });
    const group = createLazyIpcHandlerGroup([IPC.CoordinatorGetDiagnostics], load);
    const lazyHandler = group[IPC.CoordinatorGetDiagnostics];

    const firstCall = lazyHandler?.();
    const secondCall = lazyHandler?.();
    deferred.reject(new Error('load failed'));

    await expect(firstCall).rejects.toThrow('load failed');
    await expect(secondCall).rejects.toThrow('load failed');
    await expect(lazyHandler?.()).resolves.toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects calls for channels the loaded map does not provide', async () => {
    const group = createLazyIpcHandlerGroup(
      [IPC.CoordinatorGetDiagnostics, IPC.CoordinatorToolCall],
      async () => ({ [IPC.CoordinatorGetDiagnostics]: () => 'ok' }),
    );

    await expect(group[IPC.CoordinatorGetDiagnostics]?.()).resolves.toBe('ok');
    await expect(group[IPC.CoordinatorToolCall]?.()).rejects.toThrow(
      'did not provide a handler for coordinator_tool_call',
    );
  });

  it('behaves identically to eager binding once loaded', async () => {
    const eager: IpcHandlerMap = {
      [IPC.CoordinatorGetDiagnostics]: (args?: Record<string, unknown>) => ({
        args,
        kind: 'diagnostics',
      }),
    };
    const group = createLazyIpcHandlerGroup([IPC.CoordinatorGetDiagnostics], async () => eager);

    const eagerResult = await eager[IPC.CoordinatorGetDiagnostics]?.({ a: 1 });
    const lazyResult = await group[IPC.CoordinatorGetDiagnostics]?.({ a: 1 });
    expect(lazyResult).toEqual(eagerResult);
  });
});
