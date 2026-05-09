import { describe, expect, it } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

import { isRemoteLiveIpcEventChannel } from './remote-live-ipc-events';

describe('remote live IPC event channels', () => {
  it('recognizes only supported remote live event channels', () => {
    expect(isRemoteLiveIpcEventChannel(IPC.AgentSupervisionChanged)).toBe(true);
    expect(isRemoteLiveIpcEventChannel(IPC.TaskReviewChanged)).toBe(true);
    expect(isRemoteLiveIpcEventChannel(IPC.PauseAgent)).toBe(false);
    expect(isRemoteLiveIpcEventChannel('unknown-channel')).toBe(false);
  });
});
