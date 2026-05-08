import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskStepsSnapshot, TaskStepsSummarySnapshot } from '../../domain/task-steps.js';
import { resetFocusStateForTests } from '../../store/focus.js';
import { TaskStepsSection } from './TaskStepsSection.js';

describe('TaskStepsSection', () => {
  afterEach(() => {
    cleanup();
    resetFocusStateForTests();
  });

  it('renders step history and routes section actions through callbacks', () => {
    const onFileClick = vi.fn();
    const onFocusSteps = vi.fn();
    const onJumpToStep = vi.fn();
    const onNextClick = vi.fn();

    const { container } = render(() => (
      <TaskStepsSection
        loadError={() => null}
        loading={() => false}
        onFileClick={onFileClick}
        onFocusSteps={onFocusSteps}
        onJumpToStep={onJumpToStep}
        onNextClick={onNextClick}
        snapshot={() => ({
          errorMessage: null,
          revisionId: 'task-1::snapshot',
          state: 'ready',
          steps: [
            {
              detail: 'Investigated the failure',
              status: 'investigating',
              summary: 'Investigating the failure',
              timestamp: '2026-04-17T09:00:00.000Z',
            },
            {
              filesTouched: ['src/task-steps.ts'],
              next: 'Open the failing trace',
              status: 'awaiting_review',
              summary: 'Waiting for review',
              timestamp: '2026-04-17T10:00:00.000Z',
            },
          ],
          taskId: 'task-1',
          trackingEnabled: true,
          updatedAt: 1_000,
        })}
        summary={() => ({
          errorMessage: null,
          latestStep: {
            next: 'Open the failing trace',
            status: 'awaiting_review',
            summary: 'Waiting for review',
            timestamp: '2026-04-17T10:00:00.000Z',
          },
          nextAction: 'Open the failing trace',
          preview: 'Open the failing trace',
          revisionId: 'task-1::summary',
          state: 'ready',
          stepCount: 2,
          taskId: 'task-1',
          trackingEnabled: true,
          updatedAt: 1_000,
        })}
        taskId="task-1"
      />
    ));
    const view = within(container);

    expect(view.getByText('Waiting for next step')).toBeTruthy();
    expect(view.getByText('Investigating the failure')).toBeTruthy();
    expect(view.getByText('Waiting for review')).toBeTruthy();

    const nextActionButton = view.getByText('Open the failing trace').closest('button');
    expect(nextActionButton).not.toBeNull();
    if (!nextActionButton) {
      throw new Error('Expected the next-action button to be rendered');
    }
    fireEvent.click(nextActionButton);
    expect(onNextClick).toHaveBeenCalledWith('Open the failing trace');

    fireEvent.click(view.getByRole('button', { name: 'src/task-steps.ts' }));
    expect(onFileClick).toHaveBeenCalledWith('src/task-steps.ts');

    const jumpButton = view.getAllByText('Jump to terminal')[0]?.closest('button');
    expect(jumpButton).not.toBeNull();
    if (!jumpButton) {
      throw new Error('Expected the jump button to be rendered');
    }
    fireEvent.click(jumpButton);
    expect(onJumpToStep).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Investigating the failure' }),
    );

    fireEvent.click(view.getByText('Steps'));
    expect(onFocusSteps).toHaveBeenCalled();
  });

  it('updates the requested natural height when the rendered content changes', async () => {
    const onNaturalHeight = vi.fn();
    const [snapshot, setSnapshot] = createSignal<TaskStepsSnapshot>({
      errorMessage: null,
      revisionId: 'task-1::snapshot',
      state: 'waiting' as const,
      steps: [],
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_000,
    });
    const [summary, setSummary] = createSignal<TaskStepsSummarySnapshot>({
      errorMessage: null,
      latestStep: null,
      nextAction: null,
      preview: 'Waiting for the first step',
      revisionId: 'task-1::summary',
      state: 'waiting' as const,
      stepCount: 0,
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_000,
    });

    render(() => (
      <TaskStepsSection
        loadError={() => null}
        loading={() => false}
        onFileClick={() => {}}
        onFocusSteps={() => {}}
        onJumpToStep={() => {}}
        onNaturalHeight={onNaturalHeight}
        onNextClick={() => {}}
        snapshot={snapshot}
        summary={summary}
        taskId="task-1"
      />
    ));

    await waitFor(() => {
      expect(onNaturalHeight).toHaveBeenCalledTimes(1);
    });
    const initialCallCount = onNaturalHeight.mock.calls.length;

    setSnapshot({
      errorMessage: null,
      revisionId: 'task-1::snapshot-2',
      state: 'active',
      steps: [
        {
          detail: 'Investigated the failure',
          status: 'investigating',
          summary: 'Investigating the failure',
          timestamp: '2026-04-17T09:00:00.000Z',
        },
      ],
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 2_000,
    });
    setSummary({
      errorMessage: null,
      latestStep: {
        summary: 'Investigating the failure',
        status: 'investigating',
        timestamp: '2026-04-17T09:00:00.000Z',
      },
      nextAction: null,
      preview: 'Investigating the failure',
      revisionId: 'task-1::summary-2',
      state: 'active',
      stepCount: 1,
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 2_000,
    });

    await waitFor(() => {
      expect(onNaturalHeight.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('keeps existing step history visible while showing snapshot load failures', () => {
    const { container } = render(() => (
      <TaskStepsSection
        loadError={() => 'Failed to load task steps from the backend.'}
        loading={() => false}
        onFileClick={() => {}}
        onFocusSteps={() => {}}
        onJumpToStep={() => {}}
        onNextClick={() => {}}
        snapshot={() => ({
          errorMessage: null,
          revisionId: 'task-1::snapshot',
          state: 'active',
          steps: [
            {
              status: 'investigating',
              summary: 'Investigating the failure',
              timestamp: '2026-04-17T09:00:00.000Z',
            },
          ],
          taskId: 'task-1',
          trackingEnabled: true,
          updatedAt: 1_000,
        })}
        summary={() => ({
          errorMessage: null,
          latestStep: {
            status: 'investigating',
            summary: 'Investigating the failure',
            timestamp: '2026-04-17T09:00:00.000Z',
          },
          nextAction: null,
          preview: 'Investigating the failure',
          revisionId: 'task-1::summary',
          state: 'active',
          stepCount: 1,
          taskId: 'task-1',
          trackingEnabled: true,
          updatedAt: 1_000,
        })}
        taskId="task-1"
      />
    ));
    const view = within(container);

    expect(view.getByText('Steps unavailable')).toBeTruthy();
    expect(view.getByRole('status').textContent).toContain(
      'Failed to load task steps from the backend.',
    );
    expect(view.getByText('Investigating the failure')).toBeTruthy();
  });
});
