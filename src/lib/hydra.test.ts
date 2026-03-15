import { describe, expect, it } from 'vitest';
import {
  applyHydraCommandOverride,
  getHydraPromptPanelText,
  isHydraAgentDef,
  isHydraCoordinationArtifact,
  isHydraStartupMode,
} from './hydra';

describe('hydra helpers', () => {
  it('recognizes Hydra agent definitions by id or adapter', () => {
    expect(isHydraAgentDef({ id: 'hydra', adapter: undefined })).toBe(true);
    expect(isHydraAgentDef({ id: 'custom', adapter: 'hydra' })).toBe(true);
    expect(isHydraAgentDef({ id: 'codex', adapter: undefined })).toBe(false);
  });

  it('prefixes prompt-panel text with ! when force dispatch is enabled', () => {
    expect(getHydraPromptPanelText('fix auth regression', true)).toBe('!fix auth regression');
    expect(getHydraPromptPanelText('!already forced', true)).toBe('!already forced');
    expect(getHydraPromptPanelText('native chat', false)).toBe('native chat');
  });

  it('applies Hydra command overrides without touching other agents', () => {
    expect(
      applyHydraCommandOverride(
        {
          id: 'hydra',
          name: 'Hydra',
          command: 'hydra',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Hydra',
          adapter: 'hydra',
        },
        '/tmp/hydra/bin/hydra-cli.mjs',
      ).command,
    ).toBe('/tmp/hydra/bin/hydra-cli.mjs');

    expect(
      applyHydraCommandOverride(
        {
          id: 'codex',
          name: 'Codex',
          command: 'codex',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Codex',
        },
        '/tmp/hydra/bin/hydra-cli.mjs',
      ).command,
    ).toBe('codex');
  });

  it('flags Hydra coordination artifacts under docs/coordination', () => {
    expect(isHydraCoordinationArtifact('docs/coordination/AI_SYNC_STATE.json')).toBe(true);
    expect(isHydraCoordinationArtifact('./docs/coordination/runs/one.log')).toBe(true);
    expect(isHydraCoordinationArtifact('src/components/App.tsx')).toBe(false);
  });

  it('validates Hydra startup modes from the shared source of truth', () => {
    expect(isHydraStartupMode('auto')).toBe(true);
    expect(isHydraStartupMode('dispatch')).toBe(true);
    expect(isHydraStartupMode('invalid')).toBe(false);
    expect(isHydraStartupMode(undefined)).toBe(false);
  });
});
