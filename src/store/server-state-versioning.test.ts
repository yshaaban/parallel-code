import { describe, expect, it } from 'vitest';

import {
  createServerStateVersionTracker,
  noteServerStateReplacement,
  shouldApplyServerStateEventVersion,
  shouldApplyServerStateReplacement,
} from './server-state-versioning.js';

describe('server state versioning', () => {
  it('rejects non-finite replacements without poisoning existing ordering state', () => {
    const tracker = createServerStateVersionTracker();

    expect(shouldApplyServerStateReplacement(tracker, 2)).toBe(true);
    noteServerStateReplacement(tracker, ['task-1'], 2);

    for (const version of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(shouldApplyServerStateReplacement(tracker, version)).toBe(false);
      noteServerStateReplacement(tracker, ['task-2'], version);
    }

    expect(shouldApplyServerStateEventVersion(tracker, 'task-1', 1)).toBe(false);
    expect(shouldApplyServerStateEventVersion(tracker, 'task-1', 2)).toBe(true);
    expect(shouldApplyServerStateEventVersion(tracker, 'task-2', 1)).toBe(false);
    expect(shouldApplyServerStateReplacement(tracker, 1)).toBe(false);
  });
});
