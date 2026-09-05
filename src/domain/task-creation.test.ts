import { describe, expect, it } from 'vitest';

import {
  isTaskCreationIntent,
  isTaskCreationRequest,
  type TaskCreationIntent,
} from './task-creation.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from './task-creation-ticket.js';

const operationId = Buffer.alloc(16, 0x11).toString('base64url') as TaskCreationOperationId;
const operationCapability = Buffer.alloc(32, 0x22).toString(
  'base64url',
) as TaskCreationOperationCapability;

function intent(overrides: Partial<TaskCreationIntent> = {}): TaskCreationIntent {
  return {
    branchPrefixPreference: 'feature-',
    launch: {
      agentDefId: 'claude-code',
      initialPrompt: 'Implement the change',
      kind: 'agent',
      skipPermissions: false,
    },
    location: { kind: 'managed-worktree', requestedLinkNames: ['node_modules'] },
    name: 'reliable-task',
    operationCapability,
    operationId,
    operationTicket: 'ticket-1',
    projectId: 'project-1',
    stepsTracking: true,
    ...overrides,
  };
}

describe('task creation intent wire guard', () => {
  it('validates the credential-free request before a client consumes a ticket', () => {
    const {
      operationCapability: _operationCapability,
      operationId: _operationId,
      operationTicket: _operationTicket,
      ...request
    } = intent();

    expect(isTaskCreationRequest(request)).toBe(true);
    expect(isTaskCreationRequest({ ...request, name: '🚀'.repeat(65) })).toBe(false);
    expect(isTaskCreationRequest(intent())).toBe(false);
  });

  it('accepts well-formed astral characters in user-authored text fields', () => {
    expect(
      isTaskCreationIntent(
        intent({
          branchPrefixPreference: 'feature-🚀-',
          githubUrl: 'https://example.test/owner/repo-🚀',
          launch: {
            agentDefId: 'claude-code',
            initialPrompt: 'Ship this safely 🚀\nKeep the tests green.',
            kind: 'agent',
            skipPermissions: false,
          },
          location: { kind: 'managed-worktree', requestedLinkNames: ['cache-🚀'] },
          name: 'reliable-🚀',
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['name trailing high', intent({ name: 'task-\ud800' })],
    ['name lone low', intent({ name: 'task-\udc00' })],
    [
      'prompt trailing high',
      intent({
        launch: {
          agentDefId: 'claude-code',
          initialPrompt: 'prompt-\ud800',
          kind: 'agent',
          skipPermissions: false,
        },
      }),
    ],
    [
      'prompt lone low',
      intent({
        launch: {
          agentDefId: 'claude-code',
          initialPrompt: 'prompt-\udc00',
          kind: 'agent',
          skipPermissions: false,
        },
      }),
    ],
    ['branch prefix trailing high', intent({ branchPrefixPreference: 'feature-\ud800' })],
    ['GitHub URL lone low', intent({ githubUrl: 'https://example.test/\udc00' })],
    [
      'link name trailing high',
      intent({ location: { kind: 'managed-worktree', requestedLinkNames: ['cache-\ud800'] } }),
    ],
  ])('rejects malformed Unicode in %s', (_label, candidate) => {
    expect(isTaskCreationIntent(candidate)).toBe(false);
  });
});
