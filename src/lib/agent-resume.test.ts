import { describe, expect, it } from 'vitest';
import { createTestAgentDef } from '../test/store-test-helpers';
import {
  buildAgentSpawnArgs,
  getAgentResumeStrategy,
  shouldResumeAgentOnSpawn,
} from './agent-resume';

describe('agent resume helpers', () => {
  it('uses hydra session recovery for hydra agents', () => {
    const hydraAgent = createTestAgentDef({
      id: 'hydra',
      adapter: 'hydra',
      args: [],
      resume_args: [],
    });

    expect(getAgentResumeStrategy(hydraAgent)).toBe('hydra-session');
    expect(shouldResumeAgentOnSpawn(hydraAgent, true)).toBe(true);
    expect(shouldResumeAgentOnSpawn(hydraAgent, false)).toBe(false);
  });

  it('uses resume args for non-hydra agents that provide them', () => {
    const agent = createTestAgentDef({
      args: ['run'],
      resume_args: ['resume', '--last'],
      skip_permissions_args: ['--dangerous'],
    });

    expect(getAgentResumeStrategy(agent)).toBe('cli-args');
    expect(
      buildAgentSpawnArgs(agent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual(['resume', '--last', '--dangerous']);
  });

  it('falls back to base args for agents without resume support', () => {
    const agent = createTestAgentDef({
      args: ['run'],
      resume_args: [],
      skip_permissions_args: [],
    });

    expect(getAgentResumeStrategy(agent)).toBe('none');
    expect(
      buildAgentSpawnArgs(agent, {
        resumed: true,
        skipPermissions: false,
      }),
    ).toEqual(['run']);
  });

  it('respects an explicit persisted resume strategy', () => {
    const agent = createTestAgentDef({
      id: 'custom',
      adapter: undefined,
      resume_args: [],
      resume_strategy: 'hydra-session',
    });

    expect(getAgentResumeStrategy(agent)).toBe('hydra-session');
    expect(shouldResumeAgentOnSpawn(agent, true)).toBe(true);
  });

  it('tolerates legacy persisted agent defs that are missing arg arrays', () => {
    const legacyAgent = {
      ...createTestAgentDef(),
      args: undefined,
      resume_args: undefined,
      skip_permissions_args: undefined,
    } as unknown as ReturnType<typeof createTestAgentDef>;

    expect(getAgentResumeStrategy(legacyAgent)).toBe('none');
    expect(
      buildAgentSpawnArgs(legacyAgent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual([]);
  });
});
