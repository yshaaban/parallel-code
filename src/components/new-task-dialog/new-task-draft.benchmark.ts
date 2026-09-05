import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { createNewTaskDraftBaseline, hasMeaningfulNewTaskDraftChange } from './new-task-draft';

describe('new task draft comparison benchmark', () => {
  it('classifies a changed 16 KiB prompt in under 1 ms at p95', () => {
    const prompt = 'a'.repeat(16 * 1024);
    const baseline = createNewTaskDraftBaseline({ name: 'Task', prompt });
    const changed = { name: 'Task', prompt: `${prompt.slice(0, -1)}b` };
    const durationsMs: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      hasMeaningfulNewTaskDraftChange(baseline, changed);
    }

    for (let index = 0; index < 1_000; index += 1) {
      const startedAt = performance.now();
      const dirty = hasMeaningfulNewTaskDraftChange(baseline, changed);
      durationsMs.push(performance.now() - startedAt);
      expect(dirty).toBe(true);
    }

    durationsMs.sort((left, right) => left - right);
    const medianMs = durationsMs[Math.floor(durationsMs.length * 0.5)] ?? Number.POSITIVE_INFINITY;
    const p95Ms = durationsMs[Math.ceil(durationsMs.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    expect(medianMs).toBeLessThan(1);
    expect(p95Ms).toBeLessThan(1);
  });
});
