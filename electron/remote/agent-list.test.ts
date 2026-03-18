import { describe, expect, it, vi } from 'vitest';
import { buildRemoteAgentList } from './agent-list.js';

vi.mock('../ipc/pty.js', () => ({
  getActiveAgentIds: () => ['paused-agent', 'running-agent'],
  getAgentMeta: (_agentId: string) => ({
    isShell: false,
    taskId: 'task-1',
  }),
  getAgentPauseState: (agentId: string) => (agentId === 'paused-agent' ? 'manual' : null),
}));

describe('buildRemoteAgentList', () => {
  it('prefers the running agent for a task without raw status string checks', () => {
    const byAgentId = new Map([
      ['paused-agent', { exitCode: null, lastLine: '', status: 'running' as const }],
      ['running-agent', { exitCode: null, lastLine: '', status: 'running' as const }],
    ]);

    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: (agentId) =>
        byAgentId.get(agentId) ?? { exitCode: null, lastLine: '', status: 'running' },
    });

    expect(agents).toEqual([
      expect.objectContaining({
        agentId: 'running-agent',
        status: 'running',
      }),
    ]);
  });

  it('populates taskMeta when getTaskMetadata is provided', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
      getTaskMetadata: () => ({
        agentDefId: 'claude-code',
        agentDefName: 'Claude Code',
        branchName: 'feature/auth',
        directMode: false,
        folderName: 'feature-auth',
        lastPrompt: 'implement login',
      }),
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].taskMeta).toEqual({
      agentDefId: 'claude-code',
      agentDefName: 'Claude Code',
      branchName: 'feature/auth',
      directMode: false,
      folderName: 'feature-auth',
      lastPrompt: 'implement login',
    });
  });

  it('omits taskMeta when getTaskMetadata is not provided', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].taskMeta).toBeUndefined();
  });

  it('omits taskMeta when getTaskMetadata returns null', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
      getTaskMetadata: () => null,
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].taskMeta).toBeUndefined();
  });
});
