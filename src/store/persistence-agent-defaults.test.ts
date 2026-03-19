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
});
