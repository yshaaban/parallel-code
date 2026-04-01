import { describe, expect, it } from 'vitest';
import {
  blocksNewCurrentBranchTask,
  hasProjectCurrentBranchTask,
  hasTaskClosingState,
  isTaskCloseErrored,
  isTaskCloseInProgress,
  isTaskRemoving,
  isTerminalCloseInProgress,
} from './task-closing';

describe('task closing helpers', () => {
  it('treats closing and removing as in-progress close states', () => {
    expect(isTaskCloseInProgress({ closeState: { kind: 'closing' } })).toBe(true);
    expect(isTaskCloseInProgress({ closeState: { kind: 'removing' } })).toBe(true);
    expect(isTaskCloseInProgress({ closeState: { kind: 'error', message: 'Delete failed' } })).toBe(
      false,
    );
  });

  it('separates close errors from active closing work', () => {
    expect(hasTaskClosingState({ closeState: { kind: 'error', message: 'Delete failed' } })).toBe(
      true,
    );
    expect(isTaskCloseErrored({ closeState: { kind: 'error', message: 'Delete failed' } })).toBe(
      true,
    );
    expect(isTaskRemoving({ closeState: { kind: 'error', message: 'Delete failed' } })).toBe(false);
  });

  it('does not let removing current-branch tasks block new current-branch creation', () => {
    expect(blocksNewCurrentBranchTask({ closeState: { kind: 'removing' }, directMode: true })).toBe(
      false,
    );
    expect(
      hasProjectCurrentBranchTask(
        ['task-1', 'task-2'],
        {
          'task-1': {
            closeState: { kind: 'removing' },
            directMode: true,
            projectId: 'project-1',
          } as never,
          'task-2': {
            gitIsolation: 'current-branch',
            projectId: 'project-2',
          } as never,
        },
        'project-1',
      ),
    ).toBe(false);
  });

  it('treats explicit current-branch isolation like the legacy direct-mode flag', () => {
    expect(blocksNewCurrentBranchTask({ gitIsolation: 'current-branch' })).toBe(true);
    expect(blocksNewCurrentBranchTask({ gitIsolation: 'worktree' })).toBe(false);
  });

  it('shares the same close-in-progress rule for terminals', () => {
    expect(isTerminalCloseInProgress({ closingStatus: 'closing' })).toBe(true);
    expect(isTerminalCloseInProgress({ closingStatus: 'removing' })).toBe(true);
  });
});
