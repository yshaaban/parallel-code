import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import { getPeerViewerCountForTask, listPeerSessions, replacePeerSessions } from './peer-presence';

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

describe('peer presence store', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('filters malformed peer-presence snapshots before sorting and storing them', () => {
    replacePeerSessions([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-valid',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Valid Peer',
        focusedSurface: 'terminal',
        lastSeenAt: 20,
        visibility: 'visible',
      },
      {
        activeTaskId: 'task-1',
        clientId: 'peer-invalid',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: null,
        focusedSurface: 'terminal',
        lastSeenAt: 21,
        visibility: 'visible',
      },
    ] as ReadonlyArray<unknown>);

    expect(listPeerSessions()).toEqual([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-valid',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Valid Peer',
        focusedSurface: 'terminal',
        lastSeenAt: 20,
        visibility: 'visible',
      },
    ]);
    expect(getPeerViewerCountForTask('task-1')).toBe(1);
  });
});
