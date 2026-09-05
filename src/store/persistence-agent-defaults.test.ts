import { describe, expect, it } from 'vitest';

import type { AgentDef } from '../ipc/types';
import {
  createWorkspaceStateBaseAgents,
  hydratePersistedAgentDef,
} from './persistence-agent-defaults';

function createAgentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    args: ['codex'],
    resume_args: ['resume', '--last'],
    resume_strategy: 'cli-args',
    skip_permissions_args: [],
    description: 'Codex CLI',
    ...overrides,
  };
}

describe('persistence agent defaults', () => {
  it('hydrates legacy Hydra agent defs with backend session resume strategy', () => {
    const persistedAgent = createAgentDef({
      id: 'hydra',
      name: 'Hydra',
      command: 'hydra',
      args: [],
      resume_args: [],
      resume_strategy: undefined,
      description: 'Hydra',
    });
    const availableAgents = [
      createAgentDef({
        id: 'hydra',
        name: 'Hydra',
        command: 'hydra',
        args: [],
        resume_args: [],
        resume_strategy: 'hydra-session',
        adapter: 'hydra',
        description: 'Hydra',
      }),
    ];

    hydratePersistedAgentDef(persistedAgent, availableAgents, '/opt/hydra/bin/hydra');

    expect(persistedAgent).toMatchObject({
      adapter: 'hydra',
      command: '/opt/hydra/bin/hydra',
      resume_strategy: 'hydra-session',
    });
  });

  it('restores missing CLI resume metadata from the current agent catalog', () => {
    const persistedAgent = createAgentDef({
      args: [],
      resume_args: [],
      resume_strategy: undefined,
      skip_permissions_args: [],
    });
    const availableAgents = [
      createAgentDef({
        args: ['codex'],
        resume_args: ['resume', '--last'],
        resume_strategy: 'cli-args',
        skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
    ];

    hydratePersistedAgentDef(persistedAgent, availableAgents, '');

    expect(persistedAgent).toMatchObject({
      args: ['codex'],
      resume_args: ['resume', '--last'],
      resume_strategy: 'cli-args',
      skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
    });
  });

  it('hydrates persisted agent environment values and drops invalid entries', () => {
    const persistedAgent = createAgentDef({
      env: {
        CODEX_HOME: '/tmp/codex-home',
        DROP_ME: 42,
      } as never,
    });

    hydratePersistedAgentDef(persistedAgent, [], '');

    expect(persistedAgent.env).toEqual({
      CODEX_HOME: '/tmp/codex-home',
    });
  });

  it('normalizes persisted custom agents into the canonical agent shape', () => {
    const result = createWorkspaceStateBaseAgents(
      {
        customAgents: [
          {
            id: 'custom-codex',
            name: 'Custom Codex',
            command: 'codex',
          },
        ],
      } as never,
      '',
      [],
      [],
    );

    expect(result.customAgents).toEqual([
      {
        id: 'custom-codex',
        name: 'Custom Codex',
        command: 'codex',
        description: 'Custom Codex',
        args: [],
        resume_args: [],
        resume_strategy: 'none',
        skip_permissions_args: [],
      },
    ]);
  });

  it('preserves normalized custom agent environment during workspace restore', () => {
    const result = createWorkspaceStateBaseAgents(
      {
        customAgents: [
          {
            id: 'custom-codex',
            name: 'Custom Codex',
            command: 'codex',
            env: {
              CODEX_HOME: '/tmp/codex-home',
              DROP_ME: false,
            },
          },
        ],
      } as never,
      '',
      [],
      [],
    );

    expect(result.customAgents[0]?.env).toEqual({
      CODEX_HOME: '/tmp/codex-home',
    });
  });

  it('strips a reserved fallback capability forged by persisted custom data', () => {
    const custom = createAgentDef({
      id: 'custom-claude',
      resume_failure_classifier: 'claude-no-conversation-v1',
      resume_failure_fallback: 'fresh-start',
    });

    hydratePersistedAgentDef(custom, [custom], '');

    expect(custom.resume_failure_classifier).toBeUndefined();
    expect(custom.resume_failure_fallback).toBeUndefined();
  });

  it('restores fallback capability only from the separately trusted catalog', () => {
    const persisted = createAgentDef({
      id: 'claude-code',
      resume_failure_classifier: 'claude-no-conversation-v1',
      resume_failure_fallback: 'none',
    });
    const trusted = createAgentDef({
      id: 'claude-code',
      resume_failure_classifier: 'claude-no-conversation-v1',
      resume_failure_fallback: 'fresh-start',
    });

    hydratePersistedAgentDef(persisted, [trusted], '', [trusted]);

    expect(persisted).toMatchObject({
      resume_failure_classifier: 'claude-no-conversation-v1',
      resume_failure_fallback: 'fresh-start',
    });
  });

  it('keeps normalized persisted custom-agent catalogs capability-free', () => {
    const result = createWorkspaceStateBaseAgents(
      {
        customAgents: [
          {
            ...createAgentDef({ id: 'forged-claude' }),
            resume_failure_classifier: 'claude-no-conversation-v1',
            resume_failure_fallback: 'fresh-start',
          },
        ],
      } as never,
      '',
      [],
      [],
    );

    expect(result.customAgents[0]?.resume_failure_classifier).toBeUndefined();
    expect(result.customAgents[0]?.resume_failure_fallback).toBeUndefined();
  });
});
