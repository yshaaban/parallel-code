import { afterEach, describe, expect, it } from 'vitest';
import {
  isTopmostDialog,
  popDialog,
  pushDialog,
  resetDialogStackForTests,
  topDialog,
} from './dialog-stack';

afterEach(() => {
  resetDialogStackForTests();
});

describe('dialog stack', () => {
  it('reports the most recently pushed dialog as topmost', () => {
    pushDialog('first');
    pushDialog('second');

    expect(topDialog()).toBe('second');
    expect(isTopmostDialog('first')).toBe(false);
    expect(isTopmostDialog('second')).toBe(true);
  });

  it('restores the previous dialog after popping the topmost id', () => {
    pushDialog('first');
    pushDialog('second');

    popDialog('second');

    expect(topDialog()).toBe('first');
  });

  it('removes non-topmost ids without changing the topmost dialog', () => {
    pushDialog('first');
    pushDialog('second');
    pushDialog('third');

    popDialog('second');

    expect(topDialog()).toBe('third');
    expect(isTopmostDialog('second')).toBe(false);
  });

  it('does not push duplicate ids', () => {
    pushDialog('first');
    pushDialog('first');
    popDialog('first');

    expect(topDialog()).toBeNull();
  });

  it('reports no topmost dialog when the stack is empty', () => {
    expect(topDialog()).toBeNull();
    expect(isTopmostDialog('missing')).toBe(false);
  });
});
