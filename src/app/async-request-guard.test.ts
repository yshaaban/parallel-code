import { describe, expect, it } from 'vitest';

import { createAsyncRequestGuard } from './async-request-guard';

describe('createAsyncRequestGuard', () => {
  it('invalidates older requests when a newer request starts', () => {
    const revisionId = 'r1';
    const guard = createAsyncRequestGuard(() => revisionId);

    const first = guard.beginRequest();
    const second = guard.beginRequest();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isLatestRequest(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.isLatestRequest(second)).toBe(true);
  });

  it('invalidates a request when the revision changes', () => {
    let revisionId = 'r1';
    const guard = createAsyncRequestGuard(() => revisionId);

    const request = guard.beginRequest();
    revisionId = 'r2';

    expect(guard.isCurrent(request)).toBe(false);
    expect(guard.isLatestRequest(request)).toBe(true);
  });
});
