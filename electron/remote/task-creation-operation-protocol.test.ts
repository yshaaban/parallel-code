import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { TaskCreationAgentOperationSnapshot } from '../../src/domain/task-creation.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import { isCoreServerMessage, parseClientMessage } from './protocol.js';
import { isRemoteServerMessage, isTaskCatalogDeltaMessage } from './remote-message.js';
import {
  isTaskCreationOperationSnapshotMessage,
  isTaskCreationOperationSubscriptionStateMessage,
} from './task-creation-message.js';

const OPERATION_ID = Buffer.alloc(16, 0x31).toString('base64url') as TaskCreationOperationId;
const OPERATION_CAPABILITY = Buffer.alloc(32, 0x42).toString(
  'base64url',
) as TaskCreationOperationCapability;

function pendingSnapshot(): TaskCreationAgentOperationSnapshot {
  return {
    commit: 'not-committed',
    committedTaskId: null,
    committedWorkspaceRevision: null,
    current: {
      catalogVersion: 0,
      serverInstanceId: 'server-1',
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 1,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId: OPERATION_ID,
    phase: 'validating',
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'agent',
    version: 1,
  };
}

describe('task-creation websocket protocol', () => {
  it('parses exact capability-bound subscribe and capability-free unsubscribe commands', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          operationCapability: OPERATION_CAPABILITY,
          operationId: OPERATION_ID,
          type: 'subscribe-task-creation-operation',
        }),
      ),
    ).toEqual({
      operationCapability: OPERATION_CAPABILITY,
      operationId: OPERATION_ID,
      type: 'subscribe-task-creation-operation',
    });
    expect(
      parseClientMessage(
        JSON.stringify({
          operationId: OPERATION_ID,
          type: 'unsubscribe-task-creation-operation',
        }),
      ),
    ).toEqual({
      operationId: OPERATION_ID,
      type: 'unsubscribe-task-creation-operation',
    });
  });

  it('rejects missing, malformed, and extra command fields', () => {
    const invalid = [
      {
        extra: true,
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
        type: 'subscribe-task-creation-operation',
      },
      {
        operationCapability: 'not-a-capability',
        operationId: OPERATION_ID,
        type: 'subscribe-task-creation-operation',
      },
      {
        operationCapability: OPERATION_CAPABILITY,
        operationId: 'not-an-operation',
        type: 'subscribe-task-creation-operation',
      },
      {
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
        type: 'unsubscribe-task-creation-operation',
      },
      { extra: true, operationId: OPERATION_ID, type: 'unsubscribe-task-creation-operation' },
    ];
    for (const message of invalid) {
      expect(parseClientMessage(JSON.stringify(message))).toBeNull();
    }
  });

  it('accepts exact remote snapshot/state frames and rejects duplicate identity or secret fields', () => {
    const snapshot = pendingSnapshot();
    const snapshotMessage = { snapshot, type: 'task-creation-operation-snapshot' };
    const readyMessage = {
      operationId: OPERATION_ID,
      state: 'ready',
      type: 'task-creation-operation-subscription-state',
    };

    expect(isTaskCreationOperationSnapshotMessage(snapshotMessage)).toBe(true);
    expect(isTaskCreationOperationSubscriptionStateMessage(readyMessage)).toBe(true);
    expect(isRemoteServerMessage(snapshotMessage)).toBe(true);
    expect(isRemoteServerMessage(readyMessage)).toBe(true);
    expect(isCoreServerMessage(snapshotMessage)).toBe(false);
    expect(isCoreServerMessage(readyMessage)).toBe(false);
    expect(
      isTaskCreationOperationSnapshotMessage({ ...snapshotMessage, operationId: OPERATION_ID }),
    ).toBe(false);
    expect(
      isTaskCreationOperationSnapshotMessage({
        ...snapshotMessage,
        operationCapability: OPERATION_CAPABILITY,
      }),
    ).toBe(false);
    expect(
      isTaskCreationOperationSubscriptionStateMessage({
        ...readyMessage,
        operationCapability: OPERATION_CAPABILITY,
      }),
    ).toBe(false);
  });

  it('rejects extra top-level fields on catalog frames', () => {
    const batch = {
      events: [
        {
          catalogVersion: 1,
          entityId: 'task-1',
          entityKind: 'task' as const,
          kind: 'remove' as const,
          serverInstanceId: 'server-1',
        },
      ],
      fromCatalogVersion: 0,
      serverInstanceId: 'server-1',
      toCatalogVersion: 1,
    };

    expect(isTaskCatalogDeltaMessage({ batch, type: 'task-catalog-delta' })).toBe(true);
    expect(isTaskCatalogDeltaMessage({ batch, extra: true, type: 'task-catalog-delta' })).toBe(
      false,
    );
  });

  it('keeps runtime task-creation snapshot validation out of the core protocol guard', async () => {
    const source = await readFile(new URL('./protocol.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      "import type { TaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';",
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*isTaskCreationOperationSnapshot[^}]*\}\s*from\s*['"]\.\.\/\.\.\/src\/domain\/task-creation\.js['"]/u,
    );
  });
});
