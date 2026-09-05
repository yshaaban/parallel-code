import { describe, expect, it } from 'vitest';
import {
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

  it('shares the same close-in-progress rule for terminals', () => {
    expect(isTerminalCloseInProgress({ closingStatus: 'closing' })).toBe(true);
    expect(isTerminalCloseInProgress({ closingStatus: 'removing' })).toBe(true);
  });
});
