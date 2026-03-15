import { describe, expect, it } from 'vitest';
import {
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
  type ServerStateBootstrapCategory,
} from '../domain/server-state-bootstrap';
import {
  createServerStateBootstrapCategoryDescriptors,
  getServerStateBootstrapRegistryCategories,
  getServerStateListenerScope,
} from './server-state-bootstrap-registry';

function sortCategories(
  categories: ReadonlyArray<ServerStateBootstrapCategory>,
): ServerStateBootstrapCategory[] {
  return [...categories].sort();
}

describe('server state bootstrap registry guardrails', () => {
  it('registers every bootstrap category exactly once', () => {
    expect(sortCategories(getServerStateBootstrapRegistryCategories())).toEqual(
      sortCategories(SERVER_STATE_BOOTSTRAP_CATEGORIES),
    );
  });

  it('creates descriptors for every bootstrap category', () => {
    const descriptors = createServerStateBootstrapCategoryDescriptors();

    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      expect(descriptors[category]).toBeDefined();
    }

    expect(Object.keys(descriptors)).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
  });

  it('defines explicit listener scopes for browser and electron runtimes', () => {
    const expectedScopes = {
      'agent-supervision': { browser: 'persistent', electron: 'persistent' },
      'git-status': { browser: 'startup-only', electron: 'persistent' },
      'remote-status': { browser: 'none', electron: 'persistent' },
      'task-convergence': { browser: 'persistent', electron: 'persistent' },
      'task-review': { browser: 'persistent', electron: 'persistent' },
      'task-ports': { browser: 'startup-only', electron: 'persistent' },
    } as const satisfies Record<
      ServerStateBootstrapCategory,
      { browser: string; electron: string }
    >;

    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      expect(getServerStateListenerScope(category, 'browser')).toBe(
        expectedScopes[category].browser,
      );
      expect(getServerStateListenerScope(category, 'electron')).toBe(
        expectedScopes[category].electron,
      );
    }
  });
});
