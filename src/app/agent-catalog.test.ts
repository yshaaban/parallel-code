import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, invokeWithAbortSignalMock, setStoreMock, storeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  invokeWithAbortSignalMock: vi.fn(),
  setStoreMock: vi.fn(),
  storeState: {
    availableAgents: [],
    customAgents: [],
    hydraCommand: '',
  },
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  invokeWithAbortSignal: invokeWithAbortSignalMock,
}));

vi.mock('../store/state', () => ({
  setStore: setStoreMock,
  store: storeState,
}));

vi.mock('./agent-availability', () => ({
  applyKnownAgentAvailability: (agents: unknown) => agents,
}));

import { loadAgents } from './agent-catalog';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('agent catalog acquisition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.hydraCommand = '';
  });

  it('does not apply a catalog response that arrives after startup cancellation', async () => {
    const response = createDeferred<unknown>();
    invokeWithAbortSignalMock.mockReturnValue(response.promise);
    const controller = new AbortController();
    const cancellation = new Error('startup cancelled');
    const loading = loadAgents({ signal: controller.signal });

    controller.abort(cancellation);
    response.resolve([]);

    await expect(loading).rejects.toBe(cancellation);
    expect(setStoreMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
