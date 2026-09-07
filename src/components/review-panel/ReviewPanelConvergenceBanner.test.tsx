import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskConvergenceSnapshot } from '../../domain/task-convergence';
import { ReviewPanelConvergenceBanner } from './ReviewPanelConvergenceBanner';

const legacy: TaskConvergenceSnapshot = {
  branchFiles: [],
  branchName: 'task/test',
  changedFileCount: 1,
  commitCount: 2,
  conflictingFiles: [],
  hasCommittedChanges: true,
  hasUncommittedChanges: false,
  mainAheadCount: 3,
  overlapWarnings: [],
  projectId: 'project-1',
  state: 'needs-refresh',
  summary: 'Worktree is on a different branch',
  taskId: 'task-1',
  totalAdded: 1,
  totalRemoved: 0,
  updatedAt: 1,
  worktreePath: '/tmp/task-1',
};

afterEach(cleanup);

describe('review convergence explanation', () => {
  it('replaces a legacy explanation with current behind-base and branch-mismatch details without implying loading', () => {
    const [snapshot, setSnapshot] = createSignal(legacy);
    render(() => <ReviewPanelConvergenceBanner snapshot={snapshot()} stateColor="orange" />);
    expect(
      screen.getByRole('status', { name: 'Needs attention: Worktree is on a different branch' }),
    ).toBeDefined();

    setSnapshot({
      ...legacy,
      baseBranch: 'feature/platform',
      currentBranch: 'task/test',
      reviewReason: 'behind-base',
    });
    const behind = screen.getByRole('status', { name: /Behind 3:.*feature\/platform.*3 commits/ });
    expect(behind.title).toContain('Review the branch differences');
    expect(screen.getByTitle('Base branch: feature/platform').textContent).toBe('Base +3');
    expect(screen.queryByText('Refresh')).toBeNull();

    setSnapshot((current) => ({
      ...current,
      currentBranch: 'task/other',
      reviewReason: 'branch-mismatch',
    }));
    expect(
      screen.getByRole('status', { name: /Branch changed:.*task\/other.*task\/test/ }),
    ).toBeDefined();
    expect(screen.queryByText('Behind 3')).toBeNull();
    expect(screen.queryByText('Main +3')).toBeNull();
  });
});
