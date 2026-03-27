import { beforeEach, describe, expect, it } from 'vitest';

import { getAgentPromptDispatchAt, markTaskPromptDispatch } from '../app/task-prompt-dispatch';
import { setStore, store } from './core';
import { markAgentExited, restartAgent, switchAgent } from './agents';
import { createTestAgent, resetStoreForTest } from '../test/store-test-helpers';

describe('agents store lifecycle guards', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('ignores stale exit callbacks from an older agent generation', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 0,
        id: 'agent-1',
      }),
    });

    restartAgent('agent-1', false);
    expect(store.agents['agent-1']?.generation).toBe(1);
    expect(store.agents['agent-1']?.status).toBe('running');

    markAgentExited(
      'agent-1',
      {
        exit_code: 1,
        last_output: ['stale exit'],
        signal: 'SIGTERM',
      },
      0,
    );

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: null,
        generation: 1,
        signal: null,
        status: 'running',
      }),
    );
  });

  it('records exits for the current agent generation', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 2,
        id: 'agent-1',
      }),
    });

    markAgentExited(
      'agent-1',
      {
        exit_code: 17,
        last_output: ['Process exited'],
        signal: 'SIGTERM',
      },
      2,
    );

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: 17,
        generation: 2,
        lastOutput: ['Process exited'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    );
  });

  it('clears prompt dispatch state when an agent exits', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 2,
        id: 'agent-1',
      }),
    });
    markTaskPromptDispatch('agent-1', 2, 1_000);

    markAgentExited(
      'agent-1',
      {
        exit_code: 17,
        last_output: ['Process exited'],
        signal: 'SIGTERM',
      },
      2,
    );

    expect(getAgentPromptDispatchAt('agent-1', 2, 1_100)).toBeNull();
  });

  it('clears prompt dispatch state when an agent restarts or switches', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 0,
        id: 'agent-1',
      }),
    });
    markTaskPromptDispatch('agent-1', 0, 1_000);

    restartAgent('agent-1', false);
    expect(getAgentPromptDispatchAt('agent-1', 1, 1_100)).toBeNull();

    markTaskPromptDispatch('agent-1', 1, 1_200);
    switchAgent('agent-1', {
      id: 'replacement',
      name: 'Replacement',
      command: 'replacement',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'replacement',
    });

    expect(getAgentPromptDispatchAt('agent-1', 2, 1_300)).toBeNull();
  });
});
