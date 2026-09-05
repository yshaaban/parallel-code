import { beforeEach, describe, expect, it } from 'vitest';

import { getLocalDateKey } from '../lib/date';
import { resetStoreForTest } from '../test/store-test-helpers';
import { setStore, store } from './core';
import { getMergedLineTotals, getMergedTasksTodayCount } from './completion';

describe('completion metrics', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('reads the backend-projected merged task count for today', () => {
    setStore('completedTaskDate', getLocalDateKey());
    setStore('completedTaskCount', 2);

    expect(getMergedTasksTodayCount()).toBe(2);
    expect(store.completedTaskDate).toBe(getLocalDateKey());
  });

  it('ignores stored counts from previous days', () => {
    setStore('completedTaskDate', '2000-01-01');
    setStore('completedTaskCount', 9);

    expect(getMergedTasksTodayCount()).toBe(0);
  });

  it('reads backend-projected merged line totals without mutating them locally', () => {
    setStore('mergedLinesAdded', 21);
    setStore('mergedLinesRemoved', 8);

    expect(getMergedLineTotals()).toEqual({ added: 21, removed: 8 });
  });
});
