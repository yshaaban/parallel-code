import { describe, expect, it } from 'vitest';

import {
  getTaskTerminalLayoutMode,
  getTaskVisibleAiTerminalAgentIds,
} from './task-terminal-layout';
import type { Task } from './types';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    agentIds: ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'],
    branchName: 'task/test',
    id: 'task-1',
    lastPrompt: '',
    name: 'Task',
    notes: '',
    projectId: 'project-1',
    selectedAgentId: 'agent-2',
    shellAgentIds: [],
    worktreePath: '/tmp/worktree',
    ...overrides,
  };
}

describe('task terminal layout', () => {
  it('defaults to focused layout', () => {
    expect(getTaskTerminalLayoutMode({})).toBe('focused');
    expect(getTaskVisibleAiTerminalAgentIds(createTask({ terminalLayoutMode: undefined }))).toEqual(
      ['agent-2'],
    );
  });

  it('uses selected plus one sibling for split layout', () => {
    expect(getTaskVisibleAiTerminalAgentIds(createTask({ terminalLayoutMode: 'split' }))).toEqual([
      'agent-2',
      'agent-1',
    ]);
  });

  it('lets the active agent override stale selected-agent metadata', () => {
    expect(
      getTaskVisibleAiTerminalAgentIds(createTask({ terminalLayoutMode: 'split' }), 'agent-3'),
    ).toEqual(['agent-3', 'agent-1']);
  });

  it('uses selected first and caps grid layout', () => {
    expect(getTaskVisibleAiTerminalAgentIds(createTask({ terminalLayoutMode: 'grid' }))).toEqual([
      'agent-2',
      'agent-1',
      'agent-3',
      'agent-4',
    ]);
  });

  it('uses every agent with the selected agent first for stacked layout', () => {
    expect(getTaskVisibleAiTerminalAgentIds(createTask({ terminalLayoutMode: 'stacked' }))).toEqual(
      ['agent-2', 'agent-1', 'agent-3', 'agent-4', 'agent-5'],
    );
  });
});
