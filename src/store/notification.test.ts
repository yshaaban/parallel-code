import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from './state';
import { resetStoreForTest } from '../test/store-test-helpers';
import { clearNotification, showNotification } from './notification';

describe('notification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStoreForTest();
  });

  afterEach(() => {
    clearNotification();
    resetStoreForTest();
    vi.useRealTimers();
  });

  it('auto-clears info notifications after the 3s window', () => {
    showNotification('Saved');

    expect(store.notification).toEqual({ kind: 'info', message: 'Saved' });

    vi.advanceTimersByTime(2_999);
    expect(store.notification).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(store.notification).toBeNull();
  });

  it('keeps error notifications visible until explicitly dismissed', () => {
    showNotification('Failed to create terminal', { kind: 'error' });

    expect(store.notification).toEqual({
      kind: 'error',
      message: 'Failed to create terminal',
    });

    vi.advanceTimersByTime(60_000);
    expect(store.notification).toEqual({
      kind: 'error',
      message: 'Failed to create terminal',
    });

    clearNotification();
    expect(store.notification).toBeNull();
  });

  it('does not let a previous info timer clear a newer error notification', () => {
    showNotification('Saved');
    vi.advanceTimersByTime(1_000);

    showNotification('Failed to close terminal', { kind: 'error' });
    vi.advanceTimersByTime(10_000);

    expect(store.notification).toEqual({
      kind: 'error',
      message: 'Failed to close terminal',
    });
  });

  it('replaces an error notification with a newer info notification that still auto-clears', () => {
    showNotification('Failed to move task', { kind: 'error' });
    showNotification('Task moved');

    expect(store.notification).toEqual({ kind: 'info', message: 'Task moved' });

    vi.advanceTimersByTime(3_000);
    expect(store.notification).toBeNull();
  });
});
