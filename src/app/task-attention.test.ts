import { describe, expect, it } from 'vitest';
import {
  createAgentSupervisionSnapshotEvent,
  createRemovedAgentSupervisionEvent,
} from '../domain/server-state';
import {
  createTestAgent,
  createTestAgentDef,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';
import { setStore } from '../store/core';
import { store } from '../store/state';
import {
  getTaskAttentionFocusPanel,
  getTaskAttentionEntries,
  applyAgentSupervisionEvent,
  replaceAgentSupervisionSnapshots,
} from './task-attention';

describe('task attention projection', () => {
  it('stores one canonical supervision snapshot shape for bootstrap and live events', () => {
    resetStoreForTest();
    const bootstrapSnapshot = {
      agentId: 'agent-1',
      attentionReason: 'ready-for-next-step' as const,
      isShell: false,
      lastOutputAt: 1_000,
      preview: 'Ready',
      state: 'idle-at-prompt' as const,
      taskId: 'task-1',
      updatedAt: 1_000,
    };

    replaceAgentSupervisionSnapshots([bootstrapSnapshot]);

    expect(store.agentSupervision['agent-1']).toEqual(bootstrapSnapshot);
    expect(store.agentSupervision['agent-1']).not.toHaveProperty('kind');

    const liveSnapshot = {
      ...bootstrapSnapshot,
      preview: 'Still ready',
      updatedAt: 2_000,
    };
    applyAgentSupervisionEvent(createAgentSupervisionSnapshotEvent(liveSnapshot));

    expect(store.agentSupervision['agent-1']).toEqual(liveSnapshot);
    expect(store.agentSupervision['agent-1']).not.toHaveProperty('kind');

    applyAgentSupervisionEvent(createRemovedAgentSupervisionEvent('agent-1', 'task-1'));

    expect(store.agentSupervision['agent-1']).toBeUndefined();
  });

  it('keeps the highest-priority attention entry per task', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({
        id: 'agent-2',
        def: createTestAgentDef({ id: 'hydra', adapter: 'hydra', name: 'Hydra' }),
      }),
    });

    applyAgentSupervisionEvent(
      createAgentSupervisionSnapshotEvent({
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Ready',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 1_000,
      }),
    );
    applyAgentSupervisionEvent(
      createAgentSupervisionSnapshotEvent({
        agentId: 'agent-2',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 2_000,
        preview: 'Proceed? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_000,
      }),
    );

    expect(getTaskAttentionEntries()).toEqual([
      expect.objectContaining({
        agentId: 'agent-2',
        dotStatus: 'waiting',
        focusPanel: 'ai-terminal',
        group: 'needs-action',
        reason: 'waiting-input',
        taskId: 'task-1',
      }),
    ]);
  });

  it('focuses the prompt panel only for ready non-Hydra agents', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({
        id: 'agent-2',
        def: createTestAgentDef({ id: 'hydra', adapter: 'hydra', name: 'Hydra' }),
      }),
    });

    expect(
      getTaskAttentionFocusPanel({
        agentId: 'agent-1',
        dotStatus: 'ready',
        focusPanel: 'prompt',
        group: 'ready',
        label: 'Ready',
        lastOutputAt: 1_000,
        preview: 'Ready',
        reason: 'ready-for-next-step',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 1_000,
      }),
    ).toBe('prompt');

    expect(
      getTaskAttentionFocusPanel({
        agentId: 'agent-2',
        dotStatus: 'ready',
        focusPanel: 'ai-terminal',
        group: 'ready',
        label: 'Ready',
        lastOutputAt: 1_000,
        preview: 'hydra>',
        reason: 'ready-for-next-step',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 1_000,
      }),
    ).toBe('ai-terminal');
  });
});
