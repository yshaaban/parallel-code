import { describe, expect, it } from 'vitest';

import {
  createNewTaskDraftBaseline,
  hasMeaningfulNewTaskDraftChange,
  type NewTaskDraftText,
} from './new-task-draft';

interface DraftComparisonCase {
  baseline: NewTaskDraftText;
  current: NewTaskDraftText;
  dirty: boolean;
  name: string;
}

const cases: DraftComparisonCase[] = [
  {
    name: 'empty values',
    baseline: { name: '', prompt: '' },
    current: { name: '', prompt: '' },
    dirty: false,
  },
  {
    name: 'whitespace-only changes',
    baseline: { name: '', prompt: '' },
    current: { name: ' \n ', prompt: '\t  ' },
    dirty: false,
  },
  {
    name: 'trimmed equivalent values',
    baseline: { name: 'Task', prompt: 'Do the work' },
    current: { name: '  Task\n', prompt: '\nDo the work  ' },
    dirty: false,
  },
  {
    name: 'changed prompt',
    baseline: { name: 'Task', prompt: 'Do the work' },
    current: { name: 'Task', prompt: 'Do different work' },
    dirty: true,
  },
  {
    name: 'changed explicit name',
    baseline: { name: '', prompt: 'Do the work' },
    current: { name: 'Named task', prompt: 'Do the work' },
    dirty: true,
  },
  {
    name: 'deleted prefill',
    baseline: { name: 'Review PR 42', prompt: 'review https://example.com/42' },
    current: { name: '', prompt: '' },
    dirty: true,
  },
  {
    name: 'reverted values',
    baseline: { name: 'Review PR 42', prompt: 'review https://example.com/42' },
    current: { name: 'Review PR 42', prompt: 'review https://example.com/42' },
    dirty: false,
  },
  {
    name: 'meaningful multiline change',
    baseline: { name: 'Task', prompt: 'First line\nSecond line' },
    current: { name: 'Task', prompt: 'First line\nChanged second line' },
    dirty: true,
  },
  {
    name: 'exact Unicode preservation',
    baseline: { name: 'مهمة 🚀', prompt: 'راجع التغيير\n carefully' },
    current: { name: 'مهمة 🚀', prompt: 'راجع التغيير\n carefully' },
    dirty: false,
  },
  {
    name: 'Unicode normalization is not guessed',
    baseline: { name: 'Café', prompt: '' },
    current: { name: 'Cafe\u0301', prompt: '' },
    dirty: true,
  },
];

describe('new task draft comparison', () => {
  it.each(cases)('$name', ({ baseline, current, dirty }) => {
    const capturedBaseline = createNewTaskDraftBaseline(baseline);

    expect(hasMeaningfulNewTaskDraftChange(capturedBaseline, current)).toBe(dirty);
  });

  it('captures a detached, normalized baseline', () => {
    const source = { name: '  Task  ', prompt: '\nPrompt\n' };
    const baseline = createNewTaskDraftBaseline(source);

    source.name = 'Changed';
    source.prompt = 'Changed';

    expect(baseline).toEqual({ name: 'Task', prompt: 'Prompt' });
  });
});
