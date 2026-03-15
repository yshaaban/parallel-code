import { describe, expect, it } from 'vitest';

import { isPauseReason } from './server-state';

describe('server state helpers', () => {
  it('recognizes only supported pause reasons', () => {
    expect(isPauseReason('manual')).toBe(true);
    expect(isPauseReason('flow-control')).toBe(true);
    expect(isPauseReason('restore')).toBe(true);
    expect(isPauseReason('resume')).toBe(false);
    expect(isPauseReason(undefined)).toBe(false);
  });
});
