import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestTerminalPrewarm,
  resetTerminalPrewarmForTests,
  subscribeTerminalPrewarm,
} from './terminal-prewarm';

afterEach(() => {
  resetTerminalPrewarmForTests();
});

describe('terminal-prewarm', () => {
  it('notifies only matching task subscribers', () => {
    const matchingSubscriber = vi.fn();
    const otherSubscriber = vi.fn();
    const unsubscribe = subscribeTerminalPrewarm('task-1', matchingSubscriber);
    subscribeTerminalPrewarm('task-2', otherSubscriber);

    requestTerminalPrewarm('task-1', 'pointer-intent');

    expect(matchingSubscriber).toHaveBeenCalledWith('pointer-intent');
    expect(otherSubscriber).not.toHaveBeenCalled();

    unsubscribe();
    requestTerminalPrewarm('task-1', 'selection-intent');

    expect(matchingSubscriber).toHaveBeenCalledTimes(1);
  });
});
