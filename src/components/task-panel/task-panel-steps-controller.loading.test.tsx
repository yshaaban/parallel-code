import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../store/types';

vi.mock('./TaskStepsSection', () => {
  throw new Error('Optional steps chunk unavailable');
});
vi.mock('../../app/task-steps', () => ({
  fetchTaskStepsSnapshotForTask: vi.fn(async () => undefined),
  jumpToTaskStepTarget: vi.fn(),
  prefillTaskStepNextAction: vi.fn(),
}));

import { createTaskPanelStepsController } from './task-panel-steps-controller';

function task(stepsTracking: boolean): Task {
  return {
    agentIds: [],
    branchName: 'task/steps',
    id: 'steps-load-test',
    lastPrompt: '',
    name: 'Optional steps',
    notes: '',
    projectId: 'project-1',
    shellAgentIds: [],
    stepsTracking,
    taskMode: 'agent',
    worktreePath: '/tmp/steps-load-test',
  };
}

function renderSteps(stepsTracking: boolean) {
  return render(() => {
    const controller = createTaskPanelStepsController({
      focusedPanel: () => null,
      isActive: () => true,
      onDiffFileClick: vi.fn(),
      setTaskFocusedPanel: vi.fn(),
      task: () => task(stepsTracking),
    });
    return (
      <>
        <input aria-label="Existing draft" value="Keep this text" />
        {controller.stepsSection()?.content()}
      </>
    );
  });
}

describe('optional Steps view loading', () => {
  it('does not import the view when tracking is disabled', () => {
    renderSteps(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Existing draft')).toHaveProperty('value', 'Keep this text');
  });

  it('contains a chunk failure without replacing or focusing away from sibling content', async () => {
    renderSteps(true);
    const input = screen.getByLabelText('Existing draft');
    input.focus();
    expect((await screen.findByRole('alert')).textContent).toContain('Steps could not be loaded');
    expect(screen.getByLabelText('Existing draft')).toBe(input);
    expect(input).toHaveProperty('value', 'Keep this text');
    expect(document.activeElement).toBe(input);
  });
});
