import { getLocalDateKey } from '../lib/date';
import { store } from './core';

export function getMergedTasksTodayCount(): number {
  return store.completedTaskDate === getLocalDateKey() ? store.completedTaskCount : 0;
}

export function getMergedLineTotals(): { added: number; removed: number } {
  return {
    added: store.mergedLinesAdded,
    removed: store.mergedLinesRemoved,
  };
}
