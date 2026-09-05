import { describe, expect, it } from 'vitest';
import { buildTaskCatalogAgentChoices } from './task-catalog-agent-choices.js';

describe('buildTaskCatalogAgentChoices', () => {
  it('projects safe static choices and lets persisted custom definitions override defaults', () => {
    const choices = buildTaskCatalogAgentChoices(
      {
        customAgents: [
          {
            args: ['--secret'],
            command: '/private/custom-agent',
            env: { TOKEN: 'secret' },
            id: 'codex',
            name: 'Custom Codex',
            skip_permissions_args: [],
          },
        ],
      },
      [
        {
          id: 'codex',
          name: 'Codex',
          skip_permissions_args: ['--unsafe'],
        },
        { adapter: 'hydra', id: 'hydra', name: 'Hydra' },
      ],
    );

    expect(choices).toEqual([
      expect.objectContaining({
        agentDefId: 'hydra',
        providerLabel: 'Hydra',
      }),
      expect.objectContaining({
        agentDefId: 'codex',
        displayName: 'Custom Codex',
        supportsPermissionBypass: false,
      }),
    ]);
    expect(JSON.stringify(choices)).not.toMatch(/private|secret|command|env/iu);
  });

  it('ignores malformed custom entries without projecting executable fields', () => {
    expect(
      buildTaskCatalogAgentChoices(
        { customAgents: [null, { command: 'unsafe', id: 1, name: 'Bad' }] },
        [{ id: 'safe', name: 'Safe' }],
      ),
    ).toEqual([expect.objectContaining({ agentDefId: 'safe', displayName: 'Safe' })]);
  });
});
