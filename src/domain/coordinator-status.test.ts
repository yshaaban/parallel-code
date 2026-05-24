import { describe, expect, it } from 'vitest';

import {
  COORDINATOR_DEFERRED_STATUS,
  COORDINATOR_UNSUPPORTED_STATUS,
  getCoordinatorStatus,
  isCoordinatorStatus,
} from './coordinator-status';

describe('coordinator status boundary', () => {
  it('keeps coordinator unsupported when no backend owner exists', () => {
    expect(getCoordinatorStatus(false)).toEqual(COORDINATOR_UNSUPPORTED_STATUS);
    expect(isCoordinatorStatus(COORDINATOR_UNSUPPORTED_STATUS)).toBe(true);
  });

  it('keeps upstream MCP scope deferred behind a backend-owned design', () => {
    expect(getCoordinatorStatus(true)).toEqual(COORDINATOR_DEFERRED_STATUS);
    expect(COORDINATOR_DEFERRED_STATUS.upstreamScope).toContain('MCP orchestration');
    expect(isCoordinatorStatus(COORDINATOR_DEFERRED_STATUS)).toBe(true);
  });

  it('rejects vague or transport-owned coordinator shapes', () => {
    expect(isCoordinatorStatus({ kind: 'running', owner: 'renderer' })).toBe(false);
    expect(isCoordinatorStatus({ kind: 'unsupported', owner: 'renderer' })).toBe(false);
    expect(
      isCoordinatorStatus({
        kind: 'deferred',
        owner: 'transport',
        reason: 'local-design-required',
        upstreamScope: ['MCP orchestration'],
      }),
    ).toBe(false);
  });
});
