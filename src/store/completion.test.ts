import { beforeEach, describe, expect, it } from 'vitest';

import { getLocalDateKey } from '../lib/date';
import { resetStoreForTest } from '../test/store-test-helpers';
import { setStore, store } from './core';
import { getMergedTasksTodayCount, recordMergedTaskToday } from './completion';

describe('completion metrics', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('counts merged task cleanup for today', () => {
    recordMergedTaskToday();
    recordMergedTaskToday();

    expect(getMergedTasksTodayCount()).toBe(2);
    expect(store.completedTaskDate).toBe(getLocalDateKey());
  });

  it('ignores stored counts from previous days', () => {
    setStore('completedTaskDate', '2000-01-01');
    setStore('completedTaskCount', 9);

    expect(getMergedTasksTodayCount()).toBe(0);
  });
});
