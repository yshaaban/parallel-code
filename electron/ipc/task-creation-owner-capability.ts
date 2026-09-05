import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { AgentSessionOwnerAvailability } from '../../src/domain/agent-session-operation.js';
import type { AgentSessionWorkflow } from './agent-session-workflow.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import type { TaskShellSessionJournal } from './task-shell-session-journal.js';
import type {
  ManagedTaskCreationWriterCapability,
  TaskStructureMutationService,
} from './task-structure-mutations.js';

export type TaskCreationOwnerUnavailableReason =
  | 'managed-writer-inactive'
  | 'initial-prompt-owner-inactive'
  | 'agent-session-owner-inactive'
  | 'owner-epoch-mismatch'
  | 'owner-hook-set-mismatch'
  | 'shell-journal-unavailable';

export interface ActiveTaskCreationOwnerCapability {
  cutoverEpoch: string;
  hookSetVersions: {
    agentSession: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
    initialPrompt: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
  };
  kind: 'active';
  shellTopologyEpoch: string;
  writerEpoch: 'managed-initial-shell-v1';
}

export type TaskCreationOwnerCapability =
  | ActiveTaskCreationOwnerCapability
  | { kind: 'unavailable'; reason: TaskCreationOwnerUnavailableReason };

export interface TaskCreationOwnerCapabilityBundle {
  getDeploymentCapability(): Promise<TaskCreationOwnerCapability>;
  getTaskAdmissionCapability(taskId: string): Promise<TaskCreationOwnerCapability>;
}

export interface TaskCreationOwnerCapabilityDependencies {
  agentSession: Pick<AgentSessionWorkflow, 'getOwnerAvailability' | 'removalHooks'>;
  initialPrompt: Pick<TaskInitialPromptDeliveryService, 'getOwnerAvailability'>;
  shellJournal: Pick<TaskShellSessionJournal, 'getHealth' | 'getTopologyEpoch'>;
  structure: Pick<TaskStructureMutationService, 'getManagedTaskCreationWriterCapability'>;
}

const DEPLOYMENT_PROBE_TASK_ID = 'task-creation-owner-deployment-probe';

function unavailable(
  reason: TaskCreationOwnerUnavailableReason,
): Extract<TaskCreationOwnerCapability, { kind: 'unavailable' }> {
  return { kind: 'unavailable', reason };
}

function validatePrompt(
  managed: ManagedTaskCreationWriterCapability,
  prompt: TaskInitialPromptOwnerAvailability,
): Extract<TaskCreationOwnerCapability, { kind: 'unavailable' }> | null {
  if (prompt.kind !== 'active') return unavailable('initial-prompt-owner-inactive');
  if (prompt.cutoverEpoch !== managed.cutoverEpoch) return unavailable('owner-epoch-mismatch');
  if (
    prompt.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION ||
    managed.hookSetVersions['initial-prompt'] !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION
  ) {
    return unavailable('owner-hook-set-mismatch');
  }
  return null;
}

function validateAgent(
  managed: ManagedTaskCreationWriterCapability,
  agent: AgentSessionOwnerAvailability,
): Extract<TaskCreationOwnerCapability, { kind: 'unavailable' }> | null {
  if (agent.kind !== 'active') return unavailable('agent-session-owner-inactive');
  if (agent.cutoverEpoch !== managed.cutoverEpoch) return unavailable('owner-epoch-mismatch');
  if (
    agent.hookSetVersion !== AGENT_SESSION_OWNER_HOOK_SET_VERSION ||
    managed.hookSetVersions['agent-session'] !== AGENT_SESSION_OWNER_HOOK_SET_VERSION
  ) {
    return unavailable('owner-hook-set-mismatch');
  }
  return null;
}

class TaskCreationOwnerCapabilityBundleImpl implements TaskCreationOwnerCapabilityBundle {
  constructor(private readonly dependencies: TaskCreationOwnerCapabilityDependencies) {}

  async getDeploymentCapability(): Promise<TaskCreationOwnerCapability> {
    const base = await this.inspectBase();
    if (base.kind === 'unavailable') return base;
    const agentError = await this.inspectAgent(base.managed, DEPLOYMENT_PROBE_TASK_ID);
    if (agentError) return agentError;
    const probe = await this.dependencies.agentSession.removalHooks.probe();
    if (probe.kind !== 'ready') return unavailable('agent-session-owner-inactive');
    if (probe.hookSetVersion !== AGENT_SESSION_OWNER_HOOK_SET_VERSION) {
      return unavailable('owner-hook-set-mismatch');
    }
    return base.capability;
  }

  async getTaskAdmissionCapability(taskId: string): Promise<TaskCreationOwnerCapability> {
    if (
      typeof taskId !== 'string' ||
      taskId.trim().length === 0 ||
      taskId.length > 512 ||
      taskId.includes('\u0000')
    ) {
      return unavailable('agent-session-owner-inactive');
    }
    const base = await this.inspectBase();
    if (base.kind === 'unavailable') return base;
    const agent = await this.inspectAgent(base.managed, taskId);
    return agent ?? base.capability;
  }

  private async inspectAgent(
    managed: ManagedTaskCreationWriterCapability,
    taskId: string,
  ): Promise<Extract<TaskCreationOwnerCapability, { kind: 'unavailable' }> | null> {
    let agent: AgentSessionOwnerAvailability;
    try {
      agent = await this.dependencies.agentSession.getOwnerAvailability(taskId);
    } catch {
      return unavailable('agent-session-owner-inactive');
    }
    return validateAgent(managed, agent);
  }

  private async inspectBase(): Promise<
    | { kind: 'unavailable'; reason: TaskCreationOwnerUnavailableReason }
    | {
        capability: ActiveTaskCreationOwnerCapability;
        kind: 'ready';
        managed: ManagedTaskCreationWriterCapability;
      }
  > {
    const managed = this.dependencies.structure.getManagedTaskCreationWriterCapability();
    if (!managed) return unavailable('managed-writer-inactive');
    let prompt: TaskInitialPromptOwnerAvailability;
    try {
      prompt = this.dependencies.initialPrompt.getOwnerAvailability();
    } catch {
      return unavailable('initial-prompt-owner-inactive');
    }
    const promptError = validatePrompt(managed, prompt);
    if (promptError) return promptError;
    if (
      this.dependencies.shellJournal.getHealth() !== 'healthy' ||
      !this.dependencies.shellJournal.getTopologyEpoch()
    ) {
      return unavailable('shell-journal-unavailable');
    }
    return {
      capability: {
        cutoverEpoch: managed.cutoverEpoch,
        hookSetVersions: {
          agentSession: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          initialPrompt: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        },
        kind: 'active',
        shellTopologyEpoch: this.dependencies.shellJournal.getTopologyEpoch() as string,
        writerEpoch: 'managed-initial-shell-v1',
      },
      kind: 'ready',
      managed,
    };
  }
}

export function createTaskCreationOwnerCapabilityBundle(
  dependencies: TaskCreationOwnerCapabilityDependencies,
): TaskCreationOwnerCapabilityBundle {
  return new TaskCreationOwnerCapabilityBundleImpl(dependencies);
}
