import { describe, expect, it, vi } from 'vitest';
import { buildRemoteAgentList } from './agent-list.js';

vi.mock('../ipc/pty.js', () => ({
  getActiveAgentIds: () => ['paused-agent', 'running-agent'],
  getAgentMeta: (agentId: string) => ({
    isShell: false,
    ...(agentId === 'running-agent'
      ? {
          runnerIdentity: {
            agentId,
            labels: {},
            profileId: 'profile-1',
            provider: 'docker-container',
            runnerInstanceId: 'runner-1',
            startedAt: '2026-05-24T00:00:00.000Z',
            taskId: 'task-1',
          },
        }
      : {}),
    taskId: 'task-1',
  }),
  getAgentPauseState: (agentId: string) => (agentId === 'paused-agent' ? 'manual' : null),
}));

describe('buildRemoteAgentList', () => {
  it('returns every non-shell agent for a task', () => {
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
        agentId: 'paused-agent',
        status: 'paused',
      }),
      expect.objectContaining({
        agentId: 'running-agent',
        runnerInstanceId: 'runner-1',
        runnerProvider: 'docker-container',
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

    expect(agents).toHaveLength(2);
    expect(agents[0]?.taskMeta).toEqual({
      agentDefId: 'claude-code',
      agentDefName: 'Claude Code',
      branchName: 'feature/auth',
      directMode: false,
      folderName: 'feature-auth',
      lastPrompt: 'implement login',
    });
  });

  it('requests task metadata for the concrete agent instead of only the task', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
      getTaskMetadata: (taskId, agentId) => ({
        agentDefId: agentId,
        agentDefName: `${agentId} CLI`,
        branchName: taskId,
        directMode: false,
        folderName: 'feature-auth',
        lastPrompt: 'implement login',
      }),
    });

    expect(agents.map((agent) => agent.taskMeta?.agentDefId)).toEqual([
      'paused-agent',
      'running-agent',
    ]);
  });

  it('omits taskMeta when getTaskMetadata is not provided', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
    });

    expect(agents).toHaveLength(2);
    expect(agents[0]?.taskMeta).toBeUndefined();
  });

  it('omits taskMeta when getTaskMetadata returns null', () => {
    const agents = buildRemoteAgentList({
      getTaskName: () => 'Task One',
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' as const }),
      getTaskMetadata: () => null,
    });

    expect(agents).toHaveLength(2);
    expect(agents[0]?.taskMeta).toBeUndefined();
  });
});
