// @vitest-environment jsdom
import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { highlightLinesMock } = vi.hoisted(() => ({
  highlightLinesMock: vi.fn(),
}));

vi.mock('./shiki-highlighter', () => ({
  highlightLines: highlightLinesMock,
}));

import { createHighlightedMarkdown } from './marked-shiki';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createHighlightedMarkdown', () => {
  beforeEach(() => {
    highlightLinesMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not let stale highlighted markdown publish after the source is cleared', async () => {
    const highlightedCode = createDeferred<string[]>();
    highlightLinesMock.mockReturnValueOnce(highlightedCode.promise);

    await createRoot(async (dispose) => {
      try {
        const [source, setSource] = createSignal(
          ['```ts', 'const oldValue = 1;', '```'].join('\n'),
        );
        const html = createHighlightedMarkdown(source);

        await flushMicrotasks();
        expect(html()).toBe('');

        setSource('');
        await flushMicrotasks();
        expect(html()).toBe('');

        highlightedCode.resolve(['<span>const oldValue = 1;</span>']);
        await flushMicrotasks();

        expect(html()).toBe('');
      } finally {
        dispose();
      }
    });
  });
});
