import { describe, expect, it } from 'vitest';
import {
  clearBusyTaskCommandTakeoverRequest,
  markBusyTaskCommandTakeoverRequest,
  syncBusyTaskCommandTakeoverRequests,
} from './task-command-takeover-busy-state';

describe('task-command takeover busy state helpers', () => {
  it('adds request ids without reallocating when the request is already busy', () => {
    const currentRequestIds = new Set(['request-1']);

    expect(markBusyTaskCommandTakeoverRequest(currentRequestIds, 'request-1')).toBe(
      currentRequestIds,
    );
    expect([...markBusyTaskCommandTakeoverRequest(currentRequestIds, 'request-2')]).toEqual([
      'request-1',
      'request-2',
    ]);
  });

  it('clears request ids without reallocating when the request is already absent', () => {
    const currentRequestIds = new Set(['request-1']);

    expect(clearBusyTaskCommandTakeoverRequest(currentRequestIds, 'request-2')).toBe(
      currentRequestIds,
    );
    expect([...clearBusyTaskCommandTakeoverRequest(currentRequestIds, 'request-1')]).toEqual([]);
  });

  it('retains only still-active request ids', () => {
    const currentRequestIds = new Set(['request-1', 'request-2']);

    expect(syncBusyTaskCommandTakeoverRequests(currentRequestIds, currentRequestIds)).toBe(
      currentRequestIds,
    );
    expect([
      ...syncBusyTaskCommandTakeoverRequests(currentRequestIds, new Set(['request-2'])),
    ]).toEqual(['request-2']);
  });
});
