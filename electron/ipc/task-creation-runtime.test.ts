import { describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskCreationJournal } from './task-creation-journal.js';
import {
  activateTaskCreationRuntime,
  migratePreManagedTaskCreation,
} from './task-creation-runtime.js';
import type { TaskShellSessionJournal } from './task-shell-session-journal.js';
import type { TaskShellSessionWorkflow } from './task-shell-session-workflow.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';

function activeCreationJournal(): TaskCreationJournal {
  let health: ReturnType<TaskCreationJournal['getHealth']> = 'activation-required';
  return {
    activateFresh: vi.fn(async () => {
      health = 'healthy';
      return { health, topologyEpoch: 'creation-topology' };
    }),
    activateFromLegacy: vi.fn(),
    close: vi.fn(),
    compactExpired: vi.fn(),
    findConflict: vi.fn(() => []),
    flushDerivedIndex: vi.fn(),
    get: vi.fn(() => null),
    getByOperationId: vi.fn(() => null),
    getByTaskId: vi.fn(() => null),
    getCounts: vi.fn(() => ({ chargedBytes: 0, nonterminal: 0, records: 0 })),
    getHealth: vi.fn(() => health),
    getTopologyEpoch: vi.fn(() => (health === 'healthy' ? 'creation-topology' : null)),
    hasOperationId: vi.fn(() => false),
    list: vi.fn(() => []),
    repairDurability: vi.fn(),
    save: vi.fn(),
    startup: vi.fn(async () => ({ health: 'activation-required' as const })),
  };
}

function activeShellJournal(): TaskShellSessionJournal {
  let health: ReturnType<TaskShellSessionJournal['getHealth']> = 'activation-required';
  return {
    activateFresh: vi.fn(async () => {
      health = 'healthy';
      return { health, topologyEpoch: 'shell-topology' };
    }),
    activateFromLegacy: vi.fn(),
    close: vi.fn(),
    compact: vi.fn(),
    delete: vi.fn(),
    flushDerivedIndex: vi.fn(),
    get: vi.fn(() => null),
    getByTaskId: vi.fn(() => null),
    getCounts: vi.fn(() => ({
      active: 0,
      chargedBytes: 0,
      lifecycle: 0,
      records: 0,
      richAndReserved: 0,
    })),
    getHealth: vi.fn(() => health),
    getTopologyEpoch: vi.fn(() => (health === 'healthy' ? 'shell-topology' : null)),
    list: vi.fn(() => []),
    repairDurability: vi.fn(),
    save: vi.fn(),
    startup: vi.fn(async () => ({ health: 'activation-required' as const })),
  };
}

describe('task creation production activation', () => {
  it('classifies historical agent and terminal tasks without inventing operation ownership', async () => {
    await expect(
      migratePreManagedTaskCreation.classify('agent-1', { taskMode: 'agent' }),
    ).resolves.toEqual({
      operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
      shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
    });
    await expect(
      migratePreManagedTaskCreation.classify('terminal-1', { taskMode: 'terminal' }),
    ).resolves.toEqual({
      operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
      shellOwnership: { kind: 'legacy-unmanaged-terminal', migrationSchemaVersion: 1 },
    });
    await expect(migratePreManagedTaskCreation.classify('legacy-agent-1', {})).resolves.toEqual({
      operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
      shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
    });
    await expect(
      migratePreManagedTaskCreation.classify('invalid-1', { taskMode: 'invalid' }),
    ).rejects.toThrow(/canonical task mode/u);
  });

  it('opens both journals, activates the managed writer, repairs shell state, and proves owners', async () => {
    const journal = activeCreationJournal();
    const shellJournal = activeShellJournal();
    const calls: string[] = [];
    const structure = {
      activateManagedTaskCreationWriter: vi.fn(async () => {
        calls.push('managed-writer');
        return {
          cutoverEpoch: 'cutover-1',
          hookSetVersions: {
            'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
            'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          },
          kind: 'active' as const,
          writerEpoch: 'managed-initial-shell-v1' as const,
        };
      }),
      getManagedTaskCreationWriterCapability: vi.fn(() => ({
        cutoverEpoch: 'cutover-1',
        hookSetVersions: {
          'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        },
        kind: 'active' as const,
        writerEpoch: 'managed-initial-shell-v1' as const,
      })),
    } as unknown as TaskStructureMutationService;
    const shell = {
      repairAfterRestart: vi.fn(async () => {
        calls.push('shell-repair');
        return {
          cancelledBeforeCommit: 0,
          manualReconciliationRequired: 0,
          promotedAfterCommit: 0,
          runningRecovered: 0,
        };
      }),
    } as unknown as TaskShellSessionWorkflow;
    const current = {
      catalogVersion: 1,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'present' as const,
    };
    const agentSession = {
      execute: vi.fn(),
      getOwnerAvailability: vi.fn(async () => ({
        current,
        cutoverEpoch: 'cutover-1',
        hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        kind: 'active' as const,
      })),
      removalHooks: {
        probe: vi.fn(async () => ({
          hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          kind: 'ready' as const,
        })),
      },
    };
    const initialPrompt = {
      getOwnerAvailability: vi.fn(() => ({
        cutoverEpoch: 'cutover-1',
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active' as const,
      })),
      getProjection: vi.fn(),
      queue: vi.fn(),
    };

    const runtime = await activateTaskCreationRuntime({
      agentSession: agentSession as never,
      authorization: { authorize: () => true },
      creationJournal: journal,
      current: { read: vi.fn() },
      env: { isPackaged: false, userDataPath: '/tmp/unused' },
      initialPrompt: initialPrompt as never,
      preparation: {
        getCapabilities: vi.fn(),
        getPickerPage: vi.fn(),
        getWorktreeLinkCandidates: vi.fn(),
        normalizeIntent: vi.fn(),
        prepare: vi.fn(),
        reconcileFailedCommit: vi.fn(),
        resolveIntent: vi.fn(),
      },
      shell,
      shellJournal,
      structure,
    });

    expect(journal.startup).toHaveBeenCalledOnce();
    expect(journal.activateFresh).toHaveBeenCalledOnce();
    expect(shellJournal.startup).toHaveBeenCalledOnce();
    expect(shellJournal.activateFresh).toHaveBeenCalledOnce();
    expect(calls).toEqual(['managed-writer', 'shell-repair']);
    await expect(runtime.ownerCapability.getDeploymentCapability()).resolves.toMatchObject({
      cutoverEpoch: 'cutover-1',
      kind: 'active',
    });
    expect(runtime.workflow).toBeDefined();
  });
});
