import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { computeTerminalMarkdownLinks } from './terminal-links.js';

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Infinity;
}

describe('terminal Markdown link scan benchmark', () => {
  it('keeps the committed 4,096-cell worst-case fixture within hover latency budgets', () => {
    const pathText = '/tmp/project/docs/guide.md';
    const text = `${'a'.repeat(2_000)} ${pathText} ${'b'.repeat(4_096 - 2_002 - pathText.length)}`;
    const cells = [...text].map((chars) => ({
      getChars: () => chars,
      getCode: () => chars.codePointAt(0) ?? 0,
      getWidth: () => 1,
    }));
    const line = {
      getCell: (column: number) => cells[column],
      isWrapped: false,
      length: cells.length,
      translateToString: () => text,
    };
    const nullCell = cells[0];
    if (!nullCell) {
      throw new Error('Expected the benchmark fixture to include a cell');
    }
    const buffer = {
      getLine: (row: number) => (row === 0 ? line : undefined),
      getNullCell: () => nullCell,
      length: 1,
    } as Parameters<typeof computeTerminalMarkdownLinks>[0];

    for (let index = 0; index < 100; index += 1) {
      computeTerminalMarkdownLinks(buffer, 1, '/tmp/project');
    }

    const samples: number[] = [];
    let observedLinks = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const startedAt = performance.now();
      observedLinks += computeTerminalMarkdownLinks(buffer, 1, '/tmp/project').length;
      samples.push(performance.now() - startedAt);
    }

    expect(observedLinks).toBe(1_000);
    expect(percentile(samples, 0.95)).toBeLessThanOrEqual(2);
    expect(percentile(samples, 0.99)).toBeLessThanOrEqual(8);
    expect(Math.max(...samples)).toBeLessThan(50);
  });
});
