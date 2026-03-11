import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const { pauseAgentMock, resumeAgentMock, getAgentScrollbackMock, getAgentColsMock } = vi.hoisted(
  () => ({
    pauseAgentMock: vi.fn(),
    resumeAgentMock: vi.fn(),
    getAgentScrollbackMock: vi.fn(),
    getAgentColsMock: vi.fn(),
  }),
);

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    pauseAgent: pauseAgentMock,
    resumeAgent: resumeAgentMock,
    getAgentScrollback: getAgentScrollbackMock,
    getAgentCols: getAgentColsMock,
  };
});

import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

describe('GetScrollbackBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentScrollbackMock.mockImplementation((agentId: string) => `scrollback:${agentId}`);
    getAgentColsMock.mockReturnValue(80);
  });

  it('pauses each agent once and always resumes after returning the batch', () => {
    const handlers = createIpcHandlers(buildContext());

    const result = handlers[IPC.GetScrollbackBatch]?.({
      agentIds: ['agent-a', 'agent-a', 'agent-b'],
    }) as Array<{ agentId: string; scrollback: string | null; cols: number }>;

    expect(result).toEqual([
      { agentId: 'agent-a', scrollback: 'scrollback:agent-a', cols: 80 },
      { agentId: 'agent-b', scrollback: 'scrollback:agent-b', cols: 80 },
    ]);
    expect(pauseAgentMock).toHaveBeenCalledTimes(2);
    expect(pauseAgentMock).toHaveBeenNthCalledWith(1, 'agent-a', 'restore');
    expect(pauseAgentMock).toHaveBeenNthCalledWith(2, 'agent-b', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledTimes(2);
    expect(resumeAgentMock).toHaveBeenNthCalledWith(1, 'agent-b', 'restore');
    expect(resumeAgentMock).toHaveBeenNthCalledWith(2, 'agent-a', 'restore');
  });
});
