import { describe, expect, it, vi } from 'vitest';

import { parsePersistedTaskLookupState } from './persisted-task-lookup-state.js';
import { createSavedStateDocument, toSavedStateDocument } from './saved-state-document.js';

const SAVED_STATE_FIXTURES = [
  JSON.stringify({
    projects: [{ baseBranch: 'main', id: 'project-1', path: '/tmp/project' }],
    tasks: {
      'task-1': {
        branchName: 'feature/a',
        id: 'task-1',
        name: 'Task A',
        projectId: 'project-1',
        worktreePath: '/tmp/project/.worktrees/a',
      },
      'task-legacy': {
        directMode: true,
        id: 'task-legacy',
        worktreePath: '/tmp/project/.worktrees/legacy',
      },
    },
  }),
  JSON.stringify({ tasks: { partial: { name: 'only-a-name' } } }),
  JSON.stringify({ unrelated: true }),
  '"not-an-object"',
  '{corrupt json',
];

describe('saved-state document', () => {
  it('parses the JSON exactly once per document', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    const json = SAVED_STATE_FIXTURES[0] ?? '{}';

    const document = createSavedStateDocument(json);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    expect(document.json).toBe(json);
    expect(document.root).not.toBeNull();
    expect(Object.keys(document.taskLookup.tasks)).toContain('task-1');
    parseSpy.mockRestore();
  });

  it('matches the legacy task-lookup parser across legacy, partial, and corrupt fixtures', () => {
    for (const fixture of SAVED_STATE_FIXTURES) {
      const document = createSavedStateDocument(fixture);
      expect(document.taskLookup, fixture).toEqual(parsePersistedTaskLookupState(fixture));
    }
  });

  it('keeps a null root for corrupt or non-object JSON', () => {
    expect(createSavedStateDocument('{corrupt').root).toBeNull();
    expect(createSavedStateDocument('"string"').root).toBeNull();
    expect(createSavedStateDocument('[1,2]').root).toBeNull();
  });

  it('passes documents through toSavedStateDocument unchanged', () => {
    const document = createSavedStateDocument('{"tasks":{}}');
    expect(toSavedStateDocument(document)).toBe(document);
    expect(toSavedStateDocument('{"tasks":{}}').json).toBe('{"tasks":{}}');
  });
});
