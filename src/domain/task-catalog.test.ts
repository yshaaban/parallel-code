import { describe, expect, it } from 'vitest';

import {
  canDispatchToTask,
  isRemoteAgentChoice,
  isTaskCatalogDeltaBatch,
  isTaskRemovalCurrentProjection,
  reduceTaskRemovalCurrentProjection,
  type TaskRemovalCurrentProjection,
} from './task-catalog.js';

function current(
  overrides: Partial<TaskRemovalCurrentProjection> = {},
): TaskRemovalCurrentProjection {
  return {
    catalogVersion: 1,
    serverInstanceId: 'server-a',
    taskClosing: false,
    taskState: 'present',
    ...overrides,
  };
}

describe('task catalog safe current projection', () => {
  it('accepts an exact bounded static-agent row and rejects extra fields', () => {
    const agent = {
      agentDefId: 'claude-code',
      displayName: 'Claude Code',
      displayNameTruncated: false,
      glyph: 'C',
      glyphTruncated: false,
      providerLabel: 'Anthropic',
      providerLabelTruncated: false,
      supportsInitialPrompt: true,
      supportsPermissionBypass: true,
    };

    expect(isRemoteAgentChoice(agent)).toBe(true);
    expect(isRemoteAgentChoice({ ...agent, command: 'not-safe-to-project' })).toBe(false);
    expect(isRemoteAgentChoice({ ...agent, displayName: 'bad\ud800name' })).toBe(false);
    expect(isRemoteAgentChoice({ ...agent, displayName: 'bad\nname' })).toBe(false);
    expect(isRemoteAgentChoice({ ...agent, agentDefId: 'path/shaped' })).toBe(false);
  });

  it('allows actions only for a present, open task', () => {
    expect(canDispatchToTask(current())).toBe(true);
    expect(canDispatchToTask(current({ taskClosing: true }))).toBe(false);
    expect(canDispatchToTask(current({ taskState: 'removed' }))).toBe(false);
    expect(canDispatchToTask(current({ taskState: 'not-visible' }))).toBe(false);
  });

  it('orders cursors within a server instance and resets on a new instance', () => {
    const latest = current({ catalogVersion: 4, taskClosing: true });
    expect(reduceTaskRemovalCurrentProjection(latest, current({ catalogVersion: 3 }))).toBe(latest);
    expect(
      reduceTaskRemovalCurrentProjection(
        latest,
        current({ catalogVersion: 0, serverInstanceId: 'server-b' }),
      ),
    ).toMatchObject({ catalogVersion: 0, serverInstanceId: 'server-b' });
  });

  it('rejects private-state-shaped or impossible removed/closing projections', () => {
    expect(
      isTaskRemovalCurrentProjection({
        ...current({ taskState: 'removed' }),
        deletionOperationId: 'private',
        taskClosing: true,
      }),
    ).toBe(false);
  });

  it('accepts complete multi-entity versions and rejects delta version gaps', () => {
    const event = {
      catalogVersion: 2,
      entityId: 'task-1',
      entityKind: 'task',
      kind: 'remove',
      serverInstanceId: 'server-a',
    } as const;
    expect(
      isTaskCatalogDeltaBatch({
        events: [
          event,
          { ...event, entityId: 'session-1', entityKind: 'session' },
          { ...event, catalogVersion: 3, entityId: 'task-2' },
        ],
        fromCatalogVersion: 1,
        serverInstanceId: 'server-a',
        toCatalogVersion: 3,
      }),
    ).toBe(true);
    expect(
      isTaskCatalogDeltaBatch({
        events: [{ ...event, catalogVersion: 3 }],
        fromCatalogVersion: 1,
        serverInstanceId: 'server-a',
        toCatalogVersion: 3,
      }),
    ).toBe(false);
  });
});
