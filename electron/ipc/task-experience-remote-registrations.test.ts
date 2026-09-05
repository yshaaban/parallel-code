import { describe, expect, it, vi } from 'vitest';

import { REMOTE_TASK_CREATION_CAPABILITY_DARK } from '../../src/domain/task-creation.js';
import { createTaskCatalogState } from './task-catalog-state.js';
import type { RemoteCommandExecutionContext } from './remote-command-gateway.js';
import {
  createTaskExperienceRemoteCommandRegistrations,
  type TaskExperienceRemoteRuntime,
} from './task-experience-remote-registrations.js';
import { DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS } from './task-notes-writer-entitlements.js';

const context: RemoteCommandExecutionContext = {
  authEpoch: '1',
  authenticationSessionGeneration: Buffer.alloc(16, 0x23).toString('base64url'),
  hasGrant: () => true,
  principalId: 'workspace-1',
  sourceId: 'client-1',
};

describe('shared task-experience remote registrations', () => {
  it('composes the same non-overlapping manifest for either host and resolves one runtime owner', async () => {
    const catalog = createTaskCatalogState({ serverInstanceId: 'server-1' });
    const getCapabilities = vi.fn(async () => REMOTE_TASK_CREATION_CAPABILITY_DARK);
    const getTaskNotes = vi.fn(async () => ({
      ok: true as const,
      result: { current: { relation: 'task-removed' as const }, kind: 'not-found' as const },
    }));
    const runtime = {
      creation: { getCapabilities },
      notes: { getTaskNotes },
    } as unknown as TaskExperienceRemoteRuntime;
    const getRuntime = vi.fn(async () => runtime);
    const registrations = createTaskExperienceRemoteCommandRegistrations({
      catalog,
      getRuntime,
      writerEntitlement: DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS.remote,
    });

    expect(Object.keys(registrations).sort()).toEqual([
      'task-catalog.get-deltas',
      'task-catalog.get-manifest',
      'task-catalog.get-page',
      'task-creation.cancel',
      'task-creation.create',
      'task-creation.get',
      'task-creation.get-capabilities',
      'task-creation.get-picker-page',
      'task-creation.get-worktree-link-candidates',
      'task-creation.issue',
      'task-creation.retry-shell',
      'task-notes.get',
      'task-notes.issue',
      'task-notes.update',
    ]);
    const capabilities = registrations['task-creation.get-capabilities'];
    const notes = registrations['task-notes.get'];
    if (!capabilities || !notes) throw new Error('Task experience registrations are incomplete');

    await expect(capabilities.execute(context, {})).resolves.toEqual(
      REMOTE_TASK_CREATION_CAPABILITY_DARK,
    );
    await expect(notes.execute(context, { taskId: 'task-1' })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'not-found' },
    });
    expect(getRuntime).toHaveBeenCalledTimes(2);
    expect(getCapabilities).toHaveBeenCalledOnce();
    expect(getTaskNotes).toHaveBeenCalledOnce();
  });
});
