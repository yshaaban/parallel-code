import { produce } from 'solid-js/store';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearIncomingTaskTakeoverRequest,
  clearIncomingTaskTakeoverRequests,
  upsertIncomingTaskTakeoverRequest,
} from './task-command-takeovers';
import { setStore, store } from './state';

function resetIncomingTaskTakeoverRequests(): void {
  setStore(
    produce((storeState) => {
      storeState.incomingTaskTakeoverRequests = {};
    }),
  );
}

describe('task command takeover store', () => {
  beforeEach(() => {
    resetIncomingTaskTakeoverRequests();
  });

  it('removes a single incoming takeover request from the Solid store', () => {
    upsertIncomingTaskTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 1_000,
      requestId: 'request-1',
      requesterClientId: 'client-1',
      requesterDisplayName: 'Client 1',
      taskId: 'task-1',
    });
    upsertIncomingTaskTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 2_000,
      requestId: 'request-2',
      requesterClientId: 'client-2',
      requesterDisplayName: 'Client 2',
      taskId: 'task-2',
    });

    clearIncomingTaskTakeoverRequest('request-1');

    expect(store.incomingTaskTakeoverRequests['request-1']).toBeUndefined();
    expect(store.incomingTaskTakeoverRequests['request-2']).toMatchObject({
      requestId: 'request-2',
    });
  });

  it('removes all incoming takeover requests from the Solid store', () => {
    upsertIncomingTaskTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 1_000,
      requestId: 'request-1',
      requesterClientId: 'client-1',
      requesterDisplayName: 'Client 1',
      taskId: 'task-1',
    });
    upsertIncomingTaskTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 2_000,
      requestId: 'request-2',
      requesterClientId: 'client-2',
      requesterDisplayName: 'Client 2',
      taskId: 'task-2',
    });

    clearIncomingTaskTakeoverRequests();

    expect(store.incomingTaskTakeoverRequests).toEqual({});
  });
});
