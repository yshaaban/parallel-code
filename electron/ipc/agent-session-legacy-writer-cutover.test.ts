import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StorageEnv } from './storage.js';
import { WorkspaceAgentSessionLegacyWriterCutover } from './agent-session-legacy-writer-cutover.js';
import { createAgentSessionWriterRuntime } from './agent-session-writer-authority.js';
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

function createCutover(): WorkspaceAgentSessionLegacyWriterCutover {
  return new WorkspaceAgentSessionLegacyWriterCutover(
    workspace.createPrivateMutationAuthority(),
    createAgentSessionWriterRuntime({ getCurrentGeneration: () => null }),
  );
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-agent-session-writer-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('workspace agent-session legacy-writer cutover', () => {
  it('persists the exact writer epoch before opening the process-local permit gate', async () => {
    const cutover = createCutover();
    await cutover.activate('agent-session-cutover-1');

    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      agentSessionWriterSchema: {
        activeWriter: 'agent-session-operation-v1',
        cutoverEpoch: 'agent-session-cutover-1',
        legacyWritersDisabled: true,
      },
    });
    await expect(cutover.verify('agent-session-cutover-1')).resolves.toBeUndefined();
  });

  it('re-establishes the same process-local gate after restart', async () => {
    await createCutover().activate('agent-session-cutover-1');
    const restarted = createCutover();

    await expect(restarted.activate('agent-session-cutover-1')).resolves.toBeUndefined();
    await expect(restarted.verify('agent-session-cutover-1')).resolves.toBeUndefined();
  });

  it('rejects a different epoch and leaves the durable owner unchanged', async () => {
    await createCutover().activate('agent-session-cutover-1');
    await expect(createCutover().activate('agent-session-cutover-2')).rejects.toThrow(
      'conflicts with persisted state',
    );

    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      agentSessionWriterSchema: { cutoverEpoch: 'agent-session-cutover-1' },
    });
  });
});
