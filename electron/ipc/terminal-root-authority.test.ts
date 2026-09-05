import { describe, expect, it } from 'vitest';

import { createTaskNameRegistry } from '../../server/task-names.js';
import type { TaskContentAuthorityAccess } from '../../server/task-content-authority-coordinator.js';
import type { PtyContentAuthoritySnapshot } from './pty.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';

function createFixture() {
  const tasks = createTaskNameRegistry();
  const ptys = new Map<string, PtyContentAuthoritySnapshot>();
  const readPty = (access: TaskContentAuthorityAccess, agentId: string) => {
    tasks.taskContentAuthorityCoordinator.assertAccess(access);
    return ptys.get(agentId) ?? null;
  };
  const authority = createTerminalContentRootAuthority(tasks, readPty);
  const setPty = (snapshot: PtyContentAuthoritySnapshot | null, agentId = 'agent-1') => {
    tasks.taskContentAuthorityCoordinator.run(() => {
      if (snapshot) {
        ptys.set(agentId, snapshot);
      } else {
        ptys.delete(agentId);
      }
    });
  };
  return { authority, setPty, tasks };
}

function transientPty(
  overrides: Partial<PtyContentAuthoritySnapshot> = {},
): PtyContentAuthoritySnapshot {
  return {
    agentId: 'agent-1',
    authorityClass: 'explicit-transient',
    generation: 1n,
    root: '/tmp/arena',
    taskId: 'competitor-1',
    ...overrides,
  };
}

describe('terminal content root authority', () => {
  it('admits only the exact live canonical generation and consumes the token once', () => {
    const { authority, tasks } = createFixture();
    tasks.registerCreatedTask('task-1', { worktreePath: '/tmp/project' });

    const admission = authority.beginCanonicalTaskAdmission('task-1');
    expect(admission).toMatchObject({ kind: 'canonical-task', root: '/tmp/project' });
    expect(admission?.commitAfterDescriptorBind()).toBe(true);
    expect(admission?.commitAfterDescriptorBind()).toBe(false);
  });

  it.each(['closing', 'removed', 'tombstoned'] as const)(
    'denies %s canonical tasks even when an exact transient PTY lingers',
    (disposition) => {
      const { authority, setPty, tasks } = createFixture();
      tasks.registerCreatedTask('competitor-1', { worktreePath: '/tmp/project' });
      if (disposition === 'closing') {
        tasks.markTaskClosing('competitor-1');
      } else if (disposition === 'removed') {
        tasks.deleteTask('competitor-1');
      } else {
        tasks.markTaskTombstoned('competitor-1');
      }
      setPty(transientPty());

      expect(
        authority.beginTerminalAdmission({ agentId: 'agent-1', taskId: 'competitor-1' }),
      ).toBeNull();
    },
  );

  it('admits an unknown identity only through an exact explicit-transient PTY', () => {
    const { authority, setPty } = createFixture();
    setPty(transientPty());

    const admission = authority.beginTerminalAdmission({
      agentId: 'agent-1',
      taskId: 'competitor-1',
    });
    expect(admission).toMatchObject({
      canonicalDispositionGeneration: 0n,
      kind: 'explicit-transient-pty',
      ptySessionGeneration: 1n,
      root: '/tmp/arena',
    });
    expect(admission?.commitAfterDescriptorBind()).toBe(true);
  });

  it('denies missing, mismatched, and task-backed PTY selectors', () => {
    const { authority, setPty } = createFixture();
    expect(authority.beginTerminalAdmission({ taskId: 'competitor-1' })).toBeNull();

    setPty(transientPty({ authorityClass: 'task-backed' }));
    expect(
      authority.beginTerminalAdmission({ agentId: 'agent-1', taskId: 'competitor-1' }),
    ).toBeNull();

    setPty(transientPty({ taskId: 'other-task' }));
    expect(
      authority.beginTerminalAdmission({ agentId: 'agent-1', taskId: 'competitor-1' }),
    ).toBeNull();
  });

  it('denies a contradictory live-canonical and explicit-transient tuple', () => {
    const { authority, setPty, tasks } = createFixture();
    tasks.registerCreatedTask('competitor-1', { worktreePath: '/tmp/project' });
    setPty(transientPty());
    expect(
      authority.beginTerminalAdmission({ agentId: 'agent-1', taskId: 'competitor-1' }),
    ).toBeNull();
  });

  it('withdraws a canonical token when close wins before descriptor bind', () => {
    const { authority, tasks } = createFixture();
    tasks.registerCreatedTask('task-1', { worktreePath: '/tmp/project' });
    const admission = authority.beginCanonicalTaskAdmission('task-1');
    tasks.markTaskClosing('task-1');
    expect(admission?.commitAfterDescriptorBind()).toBe(false);
  });

  it.each(['created', 'restored', 'closing', 'removed', 'tombstoned'] as const)(
    'invalidates a pending transient admission after canonical %s insertion',
    (transition) => {
      const { authority, setPty, tasks } = createFixture();
      setPty(transientPty());
      const admission = authority.beginTerminalAdmission({
        agentId: 'agent-1',
        taskId: 'competitor-1',
      });
      if (transition === 'created') {
        tasks.registerCreatedTask('competitor-1', { worktreePath: '/tmp/project' });
      } else if (transition === 'restored') {
        tasks.restoreAuthorizedTaskRoots(
          JSON.stringify({
            tasks: {
              competitor: { id: 'competitor-1', worktreePath: '/tmp/project' },
            },
          }),
        );
      } else if (transition === 'closing') {
        tasks.markTaskClosing('competitor-1');
      } else if (transition === 'removed') {
        tasks.deleteTask('competitor-1');
      } else {
        tasks.markTaskTombstoned('competitor-1');
      }
      expect(admission?.commitAfterDescriptorBind()).toBe(false);
    },
  );

  it('invalidates transient PTY replacement ABA even with the same id and root', () => {
    const { authority, setPty } = createFixture();
    setPty(transientPty());
    const admission = authority.beginTerminalAdmission({
      agentId: 'agent-1',
      taskId: 'competitor-1',
    });
    setPty(transientPty({ generation: 2n }));
    expect(admission?.commitAfterDescriptorBind()).toBe(false);
  });

  it('invalidates transient PTY exit and unknown-live-removed ABA', () => {
    const first = createFixture();
    first.setPty(transientPty());
    const exited = first.authority.beginTerminalAdmission({
      agentId: 'agent-1',
      taskId: 'competitor-1',
    });
    first.setPty(null);
    expect(exited?.commitAfterDescriptorBind()).toBe(false);

    const second = createFixture();
    second.setPty(transientPty());
    const canonicalAba = second.authority.beginTerminalAdmission({
      agentId: 'agent-1',
      taskId: 'competitor-1',
    });
    second.tasks.registerCreatedTask('competitor-1', { worktreePath: '/tmp/project' });
    second.tasks.deleteTask('competitor-1');
    expect(canonicalAba?.commitAfterDescriptorBind()).toBe(false);
  });

  it('invalidates a canonical same-root close and replacement ABA', () => {
    const { authority, tasks } = createFixture();
    tasks.registerCreatedTask('task-1', { worktreePath: '/tmp/project' });
    const admission = authority.beginCanonicalTaskAdmission('task-1');
    tasks.markTaskClosing('task-1');
    tasks.registerCreatedTask('task-1', { worktreePath: '/tmp/project' });
    expect(admission?.commitAfterDescriptorBind()).toBe(false);
  });
});
