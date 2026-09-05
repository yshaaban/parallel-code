import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import {
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationWireResponse,
  isUpdateTaskNotesWireResponse,
} from '../../src/domain/task-notes.js';
import { createTaskNotesEventStream } from '../../src/runtime/task-notes-event-stream.js';
import { createIntendedTaskNotesWriterEntitlements } from '../../tests/harness/task-notes-writer-entitlements.js';
import {
  createRemoteCommandGateway,
  type RemoteCommandAuthentication,
} from '../ipc/remote-command-gateway.js';
import { createTaskNotesRemoteCommandRegistrations } from '../ipc/task-notes-remote-commands.js';
import { createTaskNotesContentVersion } from '../ipc/task-notes-operations.js';
import { TaskNotesService } from '../ipc/task-notes-service.js';
import type {
  TaskRemovalOwnerParticipant,
  TaskRemovalParticipantStepResult,
} from '../ipc/task-removal-owner.js';
import { TaskStructureMutationService } from '../ipc/task-structure-mutations.js';
import type { StorageEnv } from '../ipc/storage.js';
import { WorkspaceMutationService } from '../ipc/workspace-state-mutations.js';
import {
  cloneJsonObject,
  createElectronWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from '../ipc/workspace-state-storage.js';

const SERVER_INSTANCE_ID = '00000000-0000-4000-8000-000000000014';

let root = '';
let workspace: WorkspaceMutationService | null = null;

function environment(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

function participant(id: 'agent-session' | 'initial-prompt' | 'task-runtime') {
  const hookSetVersion =
    id === 'agent-session'
      ? AGENT_SESSION_OWNER_HOOK_SET_VERSION
      : id === 'initial-prompt'
        ? TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        : TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION;
  const complete = async (): Promise<TaskRemovalParticipantStepResult> => ({ kind: 'complete' });
  return {
    activateLegacyEffectCutover: async () => undefined,
    cleanupTaskRuntimeStep:
      id === 'task-runtime'
        ? async (request) => ({
            evidence: { state: 'complete' },
            kind: 'step-complete' as const,
            step: request.step,
          })
        : undefined,
    drainTaskForRemoval: complete,
    finalizeRemovedTaskState: complete,
    hookSetVersion,
    id,
    probe: async () => ({ hookSetVersion, kind: 'ready' as const }),
    verifyLegacyEffectCutover: async () => undefined,
  } satisfies TaskRemovalOwnerParticipant;
}

function authentication(): RemoteCommandAuthentication {
  return {
    authEpoch: 'electron-remote-epoch-1',
    authenticationSessionGeneration: 'electron-remote-session-1',
    expiresAt: Number.MAX_SAFE_INTEGER,
    grants: new Set(['notes:read', 'notes:write']),
    kind: 'trusted-local',
    principalId: 'desktop-owner',
    sourceId: 'remote-client-1',
  };
}

async function seedTask(authority: WorkspaceMutationService): Promise<void> {
  await authority.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-electron-task-notes' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          agentId: 'agent-1',
          branchName: 'task/one',
          gitIsolation: 'worktree',
          id: 'task-1',
          name: 'Task one',
          notes: 'Initial note',
          projectId: 'project-1',
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/task-1',
        },
      },
    },
    undefined,
  );
}

afterEach(async () => {
  await workspace?.close().catch(() => undefined);
  workspace = null;
  if (root) fs.rmSync(root, { force: true, recursive: true });
  root = '';
});

describe('Electron-hosted remote task notes integration', () => {
  it('drains one remote save into state.json, publishes its revision, and rejects stale full-state overwrite', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-electron-task-notes-'));
    const storage: WorkspaceStateStorage = await createElectronWorkspaceStateStorage(environment());
    const workspaceEvents: Array<{ revision: number; sourceId: string | null }> = [];
    workspace = new WorkspaceMutationService(storage, {
      emitWorkspaceStateChanged: ({ revision, sourceId }) => {
        workspaceEvents.push({ revision, sourceId });
      },
    });
    await seedTask(workspace);

    let witnessByte = 1;
    const structure = new TaskStructureMutationService(workspace, {
      removalOwner: {
        createCutoverEpoch: () => 'removal-cutover-epoch-14',
        createDeletionOperationId: () => 'deletion-operation-14',
        serverInstanceId: SERVER_INSTANCE_ID,
        taskNotes: {
          createCutoverEpoch: () => 'task-notes-cutover-epoch-14',
          createTaskIdentityWitness: () => Buffer.alloc(32, witnessByte++).toString('base64url'),
        },
      },
    });
    await structure.activateTaskRemovalOwner([
      participant('initial-prompt'),
      participant('agent-session'),
      participant('task-runtime'),
    ]);
    const structural = await structure.activateTaskNotesStructuralAuthority();
    const notesEvents = createTaskNotesEventStream();
    const rendererEvents: unknown[] = [];
    const remoteEvents: unknown[] = [];
    notesEvents.subscribe((event) => remoteEvents.push(event));
    const writerEntitlements = createIntendedTaskNotesWriterEntitlements(['remote']);
    const service = new TaskNotesService(workspace.createPrivateMutationAuthority(), structural, {
      emitTaskNotesChanged: (event) => {
        rendererEvents.push(event);
        notesEvents.publish(event);
      },
      writerEntitlements,
    });

    let releaseUpdate: (() => void) | undefined;
    let markUpdateStarted: (() => void) | undefined;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const registrations = createTaskNotesRemoteCommandRegistrations(
      {
        getTaskNotes: (...args) => service.getTaskNotes(...args),
        issueTaskNotesOperation: (...args) => service.issueTaskNotesOperation(...args),
        updateTaskNotes: async (...args) => {
          markUpdateStarted?.();
          await updateRelease;
          return service.updateTaskNotes(...args);
        },
      },
      writerEntitlements.remote,
    );
    const gateway = createRemoteCommandGateway(registrations, {
      mutationAdmissionInitiallyOpen: true,
    });
    const auth = authentication();

    const getDispatch = await gateway.dispatch('task-notes.get', auth, { taskId: 'task-1' });
    if (!getDispatch.ok || !isGetTaskNotesWireResponse(getDispatch.result)) {
      throw new Error('Expected guarded task notes bootstrap');
    }
    const getResponse = getDispatch.result;
    if (!getResponse.ok || getResponse.result.kind !== 'loaded') {
      throw new Error('Expected loaded task notes bootstrap');
    }
    const base = getResponse.result.current.currentNotes;
    if (base.kind !== 'present') throw new Error('Expected present task notes');

    const issueDispatch = await gateway.dispatch('task-notes.issue', auth, {
      taskId: 'task-1',
      taskIncarnation: base.snapshot.taskIncarnation,
    });
    if (!issueDispatch.ok || !isIssueTaskNotesOperationWireResponse(issueDispatch.result)) {
      throw new Error('Expected guarded task notes issuance');
    }
    const issueResponse = issueDispatch.result;
    if (!issueResponse.ok || issueResponse.result.kind !== 'issued') {
      throw new Error('Expected issued task notes operation');
    }

    workspaceEvents.length = 0;
    rendererEvents.length = 0;
    remoteEvents.length = 0;
    const updateDispatch = gateway.dispatch('task-notes.update', auth, {
      baseContentVersion: createTaskNotesContentVersion(base.snapshot.notes),
      notes: 'Remote durable note',
      operationCapability: issueResponse.result.operation.operationCapability,
      operationId: issueResponse.result.operation.operationId,
      taskId: 'task-1',
      taskIncarnation: base.snapshot.taskIncarnation,
    });
    await updateStarted;
    let drainComplete = false;
    const drain = gateway.closeAndDrainMutations().then(() => {
      drainComplete = true;
    });
    await Promise.resolve();
    expect(drainComplete).toBe(false);
    await expect(
      gateway.dispatch('task-notes.issue', auth, {
        taskId: 'task-1',
        taskIncarnation: base.snapshot.taskIncarnation,
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'gateway-draining' } });

    releaseUpdate?.();
    const updateGatewayResponse = await updateDispatch;
    await drain;
    expect(drainComplete).toBe(true);
    if (
      !updateGatewayResponse.ok ||
      !isUpdateTaskNotesWireResponse(updateGatewayResponse.result) ||
      !updateGatewayResponse.result.ok ||
      updateGatewayResponse.result.result.kind !== 'completed'
    ) {
      throw new Error('Expected completed remote task notes save');
    }
    const outcome = updateGatewayResponse.result.result.originalOutcome;
    if (outcome.kind !== 'saved') throw new Error('Expected saved task notes outcome');

    expect(workspaceEvents).toEqual([
      { revision: outcome.committedWorkspaceRevision, sourceId: 'remote-client-1' },
    ]);
    expect(rendererEvents).toEqual([
      {
        sourceId: 'remote-client-1',
        taskId: 'task-1',
        workspaceRevision: outcome.committedWorkspaceRevision,
      },
    ]);
    expect(remoteEvents).toEqual(rendererEvents);
    expect(fs.existsSync(path.join(root, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workspace-state.json'))).toBe(false);

    const committed = await storage.loadCurrent();
    const staleProposal = cloneJsonObject(committed.record.sharedState);
    ((staleProposal.tasks as JsonObject)['task-1'] as JsonObject).notes = 'Initial note';
    rendererEvents.length = 0;
    remoteEvents.length = 0;
    await expect(
      workspace.replaceElectronState(
        {
          expectedSharedRevision: committed.record.sharedRevision,
          operation: 'stale-save-app-state',
          sourceId: 'desktop-renderer',
        },
        {
          localState: { activeTaskId: 'task-1' },
          sharedState: staleProposal,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'workspace-protected-field-conflict' });

    const afterLegacySave = await storage.loadCurrent();
    expect(
      ((afterLegacySave.record.sharedState.tasks as JsonObject)['task-1'] as JsonObject).notes,
    ).toBe('Remote durable note');
    expect(rendererEvents).toEqual([]);
    expect(remoteEvents).toEqual([]);

    const resync = await gateway.dispatch('task-notes.get', auth, { taskId: 'task-1' });
    if (!resync.ok || !isGetTaskNotesWireResponse(resync.result) || !resync.result.ok) {
      throw new Error('Expected read-only task notes resync during drained admission');
    }
    expect(resync.result.result).toMatchObject({
      current: { currentNotes: { snapshot: { notes: 'Remote durable note' } } },
      kind: 'loaded',
    });
    expect(gateway.getCapabilities(auth)).toMatchObject({
      commands: ['task-notes.get'],
      mutationAdmission: 'draining',
    });
  });
});
