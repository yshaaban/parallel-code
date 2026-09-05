import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  measureFreshRendererMainBundle,
} from './renderer-main-bundle';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MERGE_ADAPTER_GZIP_BUDGET_BYTES = 3 * 1_024;

describe('task merge bundle budget', () => {
  it('keeps the integrated main and merge recovery adapter within fixed gzip budgets', async () => {
    const [main, accessSource, progressSource] = await Promise.all([
      measureFreshRendererMainBundle(),
      readFile(path.join(PROJECT_ROOT, 'src/app/task-merge-operation-access.ts')),
      readFile(path.join(PROJECT_ROOT, 'src/app/merge-progress.ts')),
    ]);
    const adapterGzipBytes = gzipSync(Buffer.concat([accessSource, progressSource]), {
      level: 9,
    }).byteLength;

    process.stdout.write(
      `task-merge-bundle main=${main.gzipBytes}B integratedBudget=${INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES}B adapter=${adapterGzipBytes}B adapterBudget=${MERGE_ADAPTER_GZIP_BUDGET_BYTES}B\n`,
    );
    expect(main.gzipBytes).toBeLessThan(ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES);
    expect(main.gzipBytes).toBeLessThanOrEqual(INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES);
    expect(adapterGzipBytes).toBeLessThanOrEqual(MERGE_ADAPTER_GZIP_BUDGET_BYTES);
  });
});
