import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../store/types';

vi.mock('./TaskCoordinatorSection', () => {
  throw new Error('coordinator chunk unavailable');
});

import { createTaskCoordinatorSection } from './TaskCoordinatorSectionEntry';

function createTask(): Task {
  return {
    agentIds: ['agent-coordinator'],
    branchName: 'task/coordinator',
    coordinatorRole: 'coordinator',
    coordinatorRunId: 'run-1',
    coordinatorToolCommand: 'node scripts/coordinator-tool.mjs',
    id: 'task-coordinator',
    taskMode: 'agent',
    lastPrompt: '',
    name: 'Coordinator task',
    notes: '',
    projectId: 'project-1',
    shellAgentIds: [],
    worktreePath: '/repo/.worktrees/task-coordinator',
  };
}

describe('TaskCoordinatorSectionEntry', () => {
  it('contains a lazy chunk load failure inside the coordinator rail', async () => {
    const section = createTaskCoordinatorSection({ task: () => createTask() });

    render(() => section.content());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Coordinator controls unavailable.');
    expect(alert.title.length).toBeGreaterThan(0);
  });
});
