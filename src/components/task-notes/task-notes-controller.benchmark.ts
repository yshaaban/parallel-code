import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { TaskNotesEditorState } from './task-notes-draft';
import { editTaskNotesDraft } from './task-notes-draft';

const SAMPLE_COUNT = 10_000;
const P95_BUDGET_MS = 4;
const TOKEN = 'A'.repeat(43);

describe('task notes local input benchmark', () => {
  it('updates a maximum-size local draft below the input-handler p95 budget', () => {
    const firstDraft = `${'n'.repeat(100 * 1024 - 1)}a`;
    const secondDraft = `${'n'.repeat(100 * 1024 - 1)}b`;
    let state: TaskNotesEditorState = {
      kind: 'clean',
      generation: 1,
      taskId: 'task-1',
      base: {
        taskId: 'task-1',
        taskIncarnation: TOKEN,
        notes: '',
        contentVersion: TOKEN,
        workspaceRevision: 1,
      },
      draft: '',
    };
    const samples = new Float64Array(SAMPLE_COUNT);
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      state = editTaskNotesDraft(state, index % 2 === 0 ? firstDraft : secondDraft).state;
      samples[index] = performance.now() - startedAt;
    }
    samples.sort();
    const p95 = samples[Math.ceil(SAMPLE_COUNT * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(
      `task-notes-local-input samples=${SAMPLE_COUNT} p95=${p95.toFixed(6)}ms budget=${P95_BUDGET_MS}ms\n`,
    );
    expect(state.draft).toBe(secondDraft);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
