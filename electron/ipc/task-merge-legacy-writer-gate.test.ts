import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageEnv } from './storage.js';
import {
  TaskMergeLegacyWriterDisabledError,
  WorkspaceTaskMergeLegacyWriterGate,
} from './task-merge-legacy-writer-gate.js';
import { TaskMergeOperationIssuer } from './task-merge-operation-issuer.js';
import { WorkspaceMutationService } from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-merge-legacy-gate-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('workspace task merge legacy-writer gate', () => {
  it('closes admission, drains an admitted merge, and stays closed after restart', async () => {
    const authority = workspace.createPrivateMutationAuthority();
    const gate = new WorkspaceTaskMergeLegacyWriterGate(authority);
    const issuer = new TaskMergeOperationIssuer(authority, {
      createCutoverEpoch: () => 'task-merge-cutover-1',
    });
    let releaseLegacy!: () => void;
    const legacyRelease = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    const legacyStarted = vi.fn();
    const legacy = gate.runLegacyMerge(async () => {
      legacyStarted();
      await legacyRelease;
      return 'legacy-result';
    });
    await vi.waitFor(() => expect(legacyStarted).toHaveBeenCalledOnce());

    let activated = false;
    const activation = issuer.activate(gate).then((capability) => {
      activated = true;
      return capability;
    });
    await vi.waitFor(async () => {
      await expect(gate.runLegacyMerge(async () => 'too-late')).rejects.toBeInstanceOf(
        TaskMergeLegacyWriterDisabledError,
      );
    });
    expect(activated).toBe(false);

    releaseLegacy();
    await expect(legacy).resolves.toBe('legacy-result');
    await expect(activation).resolves.toMatchObject({
      cutoverEpoch: 'task-merge-cutover-1',
      kind: 'active',
    });

    const restartedGate = new WorkspaceTaskMergeLegacyWriterGate(
      workspace.createPrivateMutationAuthority(),
    );
    const effect = vi.fn(async () => 'must-not-run');
    await expect(restartedGate.runLegacyMerge(effect)).rejects.toBeInstanceOf(
      TaskMergeLegacyWriterDisabledError,
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it('fails closed from a durable preparing barrier after interrupted activation', async () => {
    const authority = workspace.createPrivateMutationAuthority();
    const gate = new WorkspaceTaskMergeLegacyWriterGate(authority);
    const issuer = new TaskMergeOperationIssuer(authority, {
      createCutoverEpoch: () => 'task-merge-cutover-interrupted',
    });

    await expect(
      issuer.activate({
        disableLegacyMergeWriters: async (epoch) => {
          await gate.disableLegacyMergeWriters(epoch);
          throw new Error('cutover interrupted');
        },
        verifyLegacyMergeWritersDisabled: (epoch) => gate.verifyLegacyMergeWritersDisabled(epoch),
      }),
    ).rejects.toThrow('cutover interrupted');

    const restartedGate = new WorkspaceTaskMergeLegacyWriterGate(
      workspace.createPrivateMutationAuthority(),
    );
    const effect = vi.fn(async () => undefined);
    await expect(restartedGate.runLegacyMerge(effect)).rejects.toBeInstanceOf(
      TaskMergeLegacyWriterDisabledError,
    );
    expect(effect).not.toHaveBeenCalled();
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskMergeOwnerSchema: {
        cutoverEpoch: 'task-merge-cutover-interrupted',
        phase: 'preparing',
      },
    });
  });
});
