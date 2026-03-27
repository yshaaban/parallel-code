import { reconcile } from 'solid-js/store';
import type { AgentDef } from '../ipc/types';
import { createDisabledRemoteAccessStatus } from '../domain/server-state';
import { resetAppStartupStatusForTests } from '../app/app-startup-status';
import { resetTaskActivityClockForTests } from '../app/task-activity-clock';
import { resetTaskPromptDispatchStateForTests } from '../app/task-prompt-dispatch';
import { resetTaskNotificationCapabilityStateForTests } from '../app/task-notification-capabilities';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { resetTerminalFocusedInputForTests } from '../app/terminal-focused-input';
import { createInitialAppStore, setStore } from '../store/core';
import { resetTaskStatusRuntimeState } from '../store/taskStatus';
import { resetTerminalStartupStateForTests } from '../store/terminal-startup';
import type { Agent, Project, Task } from '../store/types';

export function resetStoreForTest(): void {
  const initialStore = createInitialAppStore();
  setStore(reconcile(initialStore));
  syncTerminalHighLoadMode(initialStore.terminalHighLoadMode);
  resetAppStartupStatusForTests();
  resetTaskActivityClockForTests();
  resetTerminalFocusedInputForTests();
  resetTaskStatusRuntimeState();
  resetTaskPromptDispatchStateForTests();
  resetTaskNotificationCapabilityStateForTests();
  resetTerminalStartupStateForTests();
}

export function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    path: '/tmp/project',
    color: '#4477aa',
    ...overrides,
  };
}

export function createTestAgentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Claude agent',
    ...overrides,
  };
}

export function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'feature/task-1',
    worktreePath: '/tmp/project/task-1',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    ...overrides,
  };
}

export function createTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    taskId: 'task-1',
    def: createTestAgentDef(),
    resumed: true,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
    ...overrides,
  };
}

export function setRemoteAccessForTest(
  overrides: Partial<ReturnType<typeof createDisabledRemoteAccessStatus>> = {},
): void {
  setStore('remoteAccess', {
    ...createDisabledRemoteAccessStatus(7777),
    ...overrides,
  });
}
