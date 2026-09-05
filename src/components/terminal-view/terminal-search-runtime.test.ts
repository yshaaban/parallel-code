import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import { getTerminalSearchDecorationTheme } from '../../lib/theme';
import {
  createTerminalSearchRuntime,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchResult,
} from './terminal-search-runtime';

interface SearchCall {
  direction: 'next' | 'previous';
  options: Record<string, unknown>;
  query: string;
}

class FakeSearchAddon implements ITerminalAddon {
  readonly calls: SearchCall[] = [];
  readonly listeners = new Set<(result: { resultCount: number; resultIndex: number }) => void>();
  readonly options: { highlightLimit?: number };
  activateCount = 0;
  clearCount = 0;
  disposed = false;

  constructor(options: { highlightLimit?: number } = {}) {
    this.options = options;
  }

  readonly onDidChangeResults = (
    listener: (result: { resultCount: number; resultIndex: number }) => void,
  ): IDisposable => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  activate(): void {
    this.activateCount += 1;
  }

  clearActiveDecoration(): void {}

  clearDecorations(): void {
    this.clearCount += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(result: { resultCount: number; resultIndex: number }): void {
    for (const listener of this.listeners) {
      listener(result);
    }
  }

  findNext(query: string, options: Record<string, unknown> = {}): boolean {
    this.calls.push({ direction: 'next', options, query });
    return true;
  }

  findPrevious(query: string, options: Record<string, unknown> = {}): boolean {
    this.calls.push({ direction: 'previous', options, query });
    return true;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createFrameHarness() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  return {
    cancelFrame(handle: number): void {
      callbacks.delete(handle);
    },
    flush(): void {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) {
        callback(0);
      }
    },
    get size(): number {
      return callbacks.size;
    },
    requestFrame(callback: FrameRequestCallback): number {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
  };
}

function createHarness(
  options: {
    loadAddonConstructor?: () => Promise<typeof FakeSearchAddon>;
    selection?: string;
  } = {},
) {
  const addons: FakeSearchAddon[] = [];
  const frames = createFrameHarness();
  const results: TerminalSearchResult[] = [];
  let selection = options.selection ?? '';
  const loadAddonConstructor = options.loadAddonConstructor ?? vi.fn(async () => FakeSearchAddon);
  const onUnavailable = vi.fn();
  const warn = vi.fn();
  const term = {
    getSelection: () => selection,
    loadAddon(addon: ITerminalAddon): void {
      const searchAddon = addon as FakeSearchAddon;
      addons.push(searchAddon);
      searchAddon.activate();
    },
  } as Pick<Terminal, 'getSelection' | 'loadAddon'>;
  const runtime = createTerminalSearchRuntime({
    cancelFrame: frames.cancelFrame,
    loadAddonConstructor,
    onResult: (result) => results.push(result),
    onUnavailable,
    requestFrame: frames.requestFrame,
    term,
    warn,
  });

  return {
    addons,
    frames,
    loadAddonConstructor,
    onUnavailable,
    results,
    runtime,
    setSelection(nextSelection: string): void {
      selection = nextSelection;
    },
    warn,
  };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('terminal search runtime', () => {
  it('has zero addon, listener, frame, and load cost until a non-empty query', () => {
    const harness = createHarness();

    harness.runtime.clear();
    harness.runtime.find('', { direction: 'next', incremental: true });

    expect(harness.loadAddonConstructor).not.toHaveBeenCalled();
    expect(harness.addons).toHaveLength(0);
    expect(harness.frames.size).toBe(0);
    expect(harness.results).toEqual([]);
  });

  it('loads once, attaches once, and runs only the latest query after one frame', async () => {
    const deferred = createDeferred<typeof FakeSearchAddon>();
    const loadAddonConstructor = vi.fn(() => deferred.promise);
    const harness = createHarness({ loadAddonConstructor });

    harness.runtime.find('first', { direction: 'next', incremental: true });
    harness.runtime.find('latest', { direction: 'next', incremental: true });
    expect(loadAddonConstructor).toHaveBeenCalledTimes(1);

    deferred.resolve(FakeSearchAddon);
    await settleAsyncWork();
    expect(harness.addons).toHaveLength(1);
    expect(harness.addons[0].options).toEqual({
      highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
    });
    expect(harness.addons[0].listeners.size).toBe(1);
    expect(harness.frames.size).toBe(1);

    harness.frames.flush();
    expect(harness.addons[0].calls).toEqual([
      expect.objectContaining({
        direction: 'next',
        options: expect.objectContaining({
          caseSensitive: false,
          incremental: true,
          regex: false,
          wholeWord: false,
        }),
        query: 'latest',
      }),
    ]);
  });

  it('flushes the latest incremental query before immediate navigation', async () => {
    const harness = createHarness();
    harness.runtime.find('needle', { direction: 'next', incremental: true });
    await settleAsyncWork();

    harness.runtime.find('needle', { direction: 'previous', incremental: false });

    expect(harness.frames.size).toBe(0);
    expect(
      harness.addons[0].calls.map(({ direction, options }) => [direction, options.incremental]),
    ).toEqual([
      ['next', true],
      ['previous', false],
    ]);
  });

  it('does not attach when closed or disposed while the import is pending', async () => {
    const closedDeferred = createDeferred<typeof FakeSearchAddon>();
    const closed = createHarness({ loadAddonConstructor: () => closedDeferred.promise });
    closed.runtime.find('needle', { direction: 'next', incremental: true });
    closed.runtime.close();
    closedDeferred.resolve(FakeSearchAddon);
    await settleAsyncWork();
    expect(closed.addons).toHaveLength(0);

    const disposedDeferred = createDeferred<typeof FakeSearchAddon>();
    const disposed = createHarness({ loadAddonConstructor: () => disposedDeferred.promise });
    disposed.runtime.find('needle', { direction: 'next', incremental: true });
    disposed.runtime.dispose();
    disposedDeferred.resolve(FakeSearchAddon);
    await settleAsyncWork();
    expect(disposed.addons).toHaveLength(0);
  });

  it('reports one sanitized failure per open interval and retries only after close', async () => {
    const first = createDeferred<typeof FakeSearchAddon>();
    const second = createDeferred<typeof FakeSearchAddon>();
    const loadAddonConstructor = vi
      .fn<() => Promise<typeof FakeSearchAddon>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const harness = createHarness({ loadAddonConstructor });

    harness.runtime.find('needle', { direction: 'next', incremental: true });
    first.reject(new Error('private failure details'));
    await settleAsyncWork();
    harness.runtime.find('needle again', { direction: 'next', incremental: true });
    expect(loadAddonConstructor).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith();
    expect(harness.onUnavailable).toHaveBeenCalledTimes(1);

    harness.runtime.close();
    harness.runtime.find('retry', { direction: 'next', incremental: true });
    expect(loadAddonConstructor).toHaveBeenCalledTimes(2);
    second.resolve(FakeSearchAddon);
    await settleAsyncWork();
    harness.frames.flush();
    expect(harness.addons[0].calls[0].query).toBe('retry');
  });

  it('normalizes result events and ignores stale callbacks after close', async () => {
    const harness = createHarness();
    harness.runtime.find('needle', { direction: 'next', incremental: true });
    await settleAsyncWork();
    harness.frames.flush();
    const addon = harness.addons[0];

    addon.emit({ resultCount: 3, resultIndex: 1 });
    addon.emit({ resultCount: 2_000, resultIndex: -1 });
    expect(harness.results).toEqual([
      { count: 3, index: 1 },
      { count: TERMINAL_SEARCH_HIGHLIGHT_LIMIT, index: -1 },
    ]);

    const staleListeners = [...addon.listeners];
    harness.runtime.close();
    expect(addon.disposed).toBe(true);
    expect(addon.listeners.size).toBe(0);
    expect(harness.results.at(-1)).toEqual({ count: 0, index: -1 });
    staleListeners[0]({ resultCount: 9, resultIndex: 3 });
    expect(harness.results.at(-1)).toEqual({ count: 0, index: -1 });
  });

  it('emits completion when a new request has the same numeric result', async () => {
    const harness = createHarness();
    harness.runtime.find('first', { direction: 'next', incremental: true });
    await settleAsyncWork();
    harness.frames.flush();
    const addon = harness.addons[0];
    addon.emit({ resultCount: 1, resultIndex: 0 });

    harness.runtime.find('second', { direction: 'next', incremental: true });
    harness.frames.flush();
    addon.emit({ resultCount: 1, resultIndex: 0 });

    harness.runtime.find('second', { direction: 'next', incremental: false });
    addon.emit({ resultCount: 1, resultIndex: 0 });

    expect(harness.results).toEqual([
      { count: 1, index: 0 },
      { count: 1, index: 0 },
      { count: 1, index: 0 },
    ]);
  });

  it('bounds the query at the runtime boundary', async () => {
    const harness = createHarness();
    harness.runtime.find('x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT + 10), {
      direction: 'next',
      incremental: true,
    });
    await settleAsyncWork();
    harness.frames.flush();

    expect(harness.addons[0].calls[0].query).toHaveLength(TERMINAL_SEARCH_QUERY_LIMIT);
  });

  it('accepts only non-empty bounded single-line selection seeds', () => {
    const harness = createHarness({ selection: 'selected text' });
    expect(harness.runtime.getSelectionSeed()).toBe('selected text');

    harness.setSelection('first\nsecond');
    expect(harness.runtime.getSelectionSeed()).toBe('');
    harness.setSelection('x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT + 1));
    expect(harness.runtime.getSelectionSeed()).toBe('');
    harness.setSelection('');
    expect(harness.runtime.getSelectionSeed()).toBe('');
  });

  it('falls back from invalid colors and reapplies a valid theme without recreating the addon', async () => {
    const harness = createHarness();
    harness.runtime.setDecorationTheme({
      ...getTerminalSearchDecorationTheme('ember'),
      matchBackground: 'var(--unsafe)',
    });
    harness.runtime.find('needle', { direction: 'next', incremental: true });
    await settleAsyncWork();
    harness.frames.flush();

    expect(harness.addons[0].calls[0].options.decorations).toEqual(
      getTerminalSearchDecorationTheme('classic'),
    );

    harness.runtime.setDecorationTheme(getTerminalSearchDecorationTheme('glacier'));
    expect(harness.frames.size).toBe(1);
    harness.frames.flush();
    expect(harness.addons).toHaveLength(1);
    expect(harness.addons[0].calls.at(-1)?.options.decorations).toEqual(
      getTerminalSearchDecorationTheme('glacier'),
    );
  });

  it('cancels pending work and releases the exact listener and addon on disposal', async () => {
    const harness = createHarness();
    harness.runtime.find('needle', { direction: 'next', incremental: true });
    await settleAsyncWork();
    const addon = harness.addons[0];
    expect(harness.frames.size).toBe(1);

    harness.runtime.dispose();
    expect(harness.frames.size).toBe(0);
    expect(addon.listeners.size).toBe(0);
    expect(addon.disposed).toBe(true);
    expect(addon.clearCount).toBe(1);

    harness.runtime.find('ignored', { direction: 'next', incremental: true });
    expect(harness.loadAddonConstructor).toHaveBeenCalledTimes(1);
  });

  it('leaves no addon, listener, or frame owner after 100 close and dispose cycles', async () => {
    const reopened = createHarness();
    for (let index = 0; index < 100; index += 1) {
      reopened.runtime.find(`needle-${index}`, { direction: 'next', incremental: true });
      await settleAsyncWork();
      reopened.frames.flush();
      reopened.runtime.close();
      const addon = reopened.addons[index];
      expect(addon.disposed).toBe(true);
      expect(addon.listeners.size).toBe(0);
      expect(reopened.frames.size).toBe(0);
    }
    expect(reopened.addons).toHaveLength(100);

    const disposedAddons: FakeSearchAddon[] = [];
    for (let index = 0; index < 100; index += 1) {
      const harness = createHarness();
      harness.runtime.find(`dispose-${index}`, { direction: 'next', incremental: true });
      await settleAsyncWork();
      harness.runtime.dispose();
      expect(harness.frames.size).toBe(0);
      disposedAddons.push(...harness.addons);
    }
    expect(disposedAddons).toHaveLength(100);
    expect(disposedAddons.every((addon) => addon.disposed && addon.listeners.size === 0)).toBe(
      true,
    );
  });
});
