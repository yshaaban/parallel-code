import { describe, expect, it } from 'vitest';
import { createTestAgentDef } from '../test/store-test-helpers';
import { getAgentSpawnEnvironment } from './agent-spawn-config';

describe('agent spawn config', () => {
  it('passes custom agent environment through to non-Hydra agents', () => {
    const agent = createTestAgentDef({
      env: {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_BASE: 'https://example.test',
      },
    });

    expect(getAgentSpawnEnvironment(agent, 'smart')).toEqual({
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_BASE: 'https://example.test',
    });
  });

  it('preserves custom environment while adding Hydra startup mode', () => {
    const agent = createTestAgentDef({
      adapter: 'hydra',
      env: {
        HYDRA_HOME: '/tmp/hydra-home',
      },
      id: 'hydra',
    });

    expect(getAgentSpawnEnvironment(agent, 'smart')).toEqual({
      HYDRA_HOME: '/tmp/hydra-home',
      PARALLEL_CODE_HYDRA_STARTUP_MODE: 'smart',
    });
  });
});
