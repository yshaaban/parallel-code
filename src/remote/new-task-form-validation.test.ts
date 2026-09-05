import { describe, expect, it } from 'vitest';

import type { TaskCreationCapabilities } from '../domain/task-creation';
import type { RemoteProjectSummary } from '../domain/task-catalog';
import {
  validateRemoteNewTaskDraft,
  type RemoteNewTaskDraftValidationInput,
} from './new-task-form-validation';

function capabilities(): TaskCreationCapabilities {
  return {
    coordinator: { reason: 'coordinator-not-supported', supported: false },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    modes: { agent: { enabled: true }, terminal: { enabled: true } },
    permissionBypass: { enabled: true },
  };
}

function project(): RemoteProjectSummary {
  return {
    baseBranchChoiceCount: 0,
    baseBranchChoicesTruncated: false,
    id: 'project-1',
    label: 'Project one',
    labelTruncated: false,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    projectMode: 'git',
    worktreeChoiceCount: 0,
    worktreeChoicesTruncated: false,
  };
}

function draft(
  overrides: Partial<RemoteNewTaskDraftValidationInput> = {},
): RemoteNewTaskDraftValidationInput {
  return {
    agentAvailable: true,
    branchPrefixPreference: 'feature-',
    capabilities: capabilities(),
    existingWorktreeRef: '',
    githubUrl: 'https://github.com/example/repo',
    initialPrompt: 'Implement safely 🚀',
    location: 'managed-worktree',
    name: 'remote-task',
    project: project(),
    taskMode: 'agent',
    ...overrides,
  };
}

describe('remote new-task form validation', () => {
  it('accepts a complete scalar-valid draft', () => {
    expect(validateRemoteNewTaskDraft(draft())).toEqual({});
  });

  it.each(['project-root', 'existing-worktree'] as const)(
    'does not validate an irrelevant hidden branch prefix for %s',
    (location) => {
      expect(
        validateRemoteNewTaskDraft(
          draft({
            branchPrefixPreference: '🚀'.repeat(25),
            existingWorktreeRef: 'existing-ref',
            location,
          }),
        ),
      ).toEqual({});
    },
  );

  it('reports the exact UTF-8 bounded field instead of consuming a ticket', () => {
    expect(validateRemoteNewTaskDraft(draft({ name: '🚀'.repeat(65) }))).toHaveProperty('name');
    expect(validateRemoteNewTaskDraft(draft({ initialPrompt: 'a'.repeat(65_537) }))).toHaveProperty(
      'prompt',
    );
    expect(
      validateRemoteNewTaskDraft(draft({ branchPrefixPreference: '🚀'.repeat(25) })),
    ).toHaveProperty('branchPrefix');
    expect(validateRemoteNewTaskDraft(draft({ githubUrl: '🚀'.repeat(513) }))).toHaveProperty(
      'githubUrl',
    );
  });

  it('rejects malformed scalar/control text and ignores a hidden terminal prompt', () => {
    expect(validateRemoteNewTaskDraft(draft({ name: 'bad\ud800' }))).toHaveProperty('name');
    expect(validateRemoteNewTaskDraft(draft({ initialPrompt: 'bad\u0000' }))).toHaveProperty(
      'prompt',
    );
    expect(
      validateRemoteNewTaskDraft(
        draft({ initialPrompt: 'a'.repeat(65_537), taskMode: 'terminal' }),
      ),
    ).not.toHaveProperty('prompt');
  });

  it('associates capability and imported-worktree failures with their controls', () => {
    const unavailable = capabilities();
    unavailable.modes.agent = { enabled: false, reason: 'backend-not-ready' };
    unavailable.locations['existing-worktree'] = {
      enabled: false,
      reason: 'project-mode-unavailable',
    };

    expect(
      validateRemoteNewTaskDraft(
        draft({
          agentAvailable: false,
          capabilities: unavailable,
          existingWorktreeRef: '',
          location: 'existing-worktree',
          project: null,
        }),
      ),
    ).toMatchObject({
      agent: expect.any(String),
      existingWorktree: expect.any(String),
      project: expect.any(String),
      taskMode: expect.any(String),
    });
  });
});
