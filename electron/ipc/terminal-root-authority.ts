import type { CanonicalTaskRootDisposition, TaskNameRegistry } from '../../server/task-names.js';
import {
  readPtyContentAuthorityUnderCoordinator,
  type PtyContentAuthoritySnapshot,
} from './pty.js';

export type PendingTaskContentRootAdmission =
  | {
      readonly canonicalDispositionGeneration: bigint;
      readonly coordinatorIdentity: symbol;
      readonly kind: 'canonical-task';
      readonly root: string;
      commitAfterDescriptorBind(): boolean;
    }
  | {
      readonly canonicalDispositionGeneration: bigint;
      readonly coordinatorIdentity: symbol;
      readonly kind: 'explicit-transient-pty';
      readonly ptySessionGeneration: bigint;
      readonly root: string;
      commitAfterDescriptorBind(): boolean;
    };

export interface TerminalContentRootAuthority {
  beginCanonicalTaskAdmission(taskId: string): PendingTaskContentRootAdmission | null;
  beginTerminalAdmission(request: {
    agentId?: string;
    taskId: string;
  }): PendingTaskContentRootAdmission | null;
}

type TaskAuthorityOwner = Pick<
  TaskNameRegistry,
  'readTaskContentRootUnderAuthorityCoordinator' | 'taskContentAuthorityCoordinator'
>;

type PtyAuthorityReader = typeof readPtyContentAuthorityUnderCoordinator;

function createOneShotAdmission<TAdmission extends object>(
  admission: TAdmission,
  commit: () => boolean,
): Readonly<TAdmission & { commitAfterDescriptorBind(): boolean }> {
  let consumed = false;
  return Object.freeze({
    ...admission,
    commitAfterDescriptorBind(): boolean {
      if (consumed) {
        return false;
      }
      consumed = true;
      return commit();
    },
  });
}

function isKnownNonLiveDisposition(disposition: CanonicalTaskRootDisposition): boolean {
  return (
    disposition.kind === 'closing' ||
    disposition.kind === 'removed' ||
    disposition.kind === 'tombstoned'
  );
}

export function createTerminalContentRootAuthority(
  taskOwner: TaskAuthorityOwner,
  readPtyAuthority: PtyAuthorityReader = readPtyContentAuthorityUnderCoordinator,
): TerminalContentRootAuthority {
  const coordinator = taskOwner.taskContentAuthorityCoordinator;

  function createCanonicalAdmission(options: {
    generation: bigint;
    root: string;
    taskId: string;
  }): PendingTaskContentRootAdmission {
    return createOneShotAdmission(
      {
        canonicalDispositionGeneration: options.generation,
        coordinatorIdentity: coordinator.identity,
        kind: 'canonical-task' as const,
        root: options.root,
      },
      () =>
        coordinator.run((access) => {
          const current = taskOwner.readTaskContentRootUnderAuthorityCoordinator(
            access,
            options.taskId,
          );
          return (
            current.kind === 'live' &&
            current.generation === options.generation &&
            current.root === options.root
          );
        }),
    );
  }

  function createTransientAdmission(options: {
    canonicalGeneration: bigint;
    pty: PtyContentAuthoritySnapshot;
  }): PendingTaskContentRootAdmission {
    return createOneShotAdmission(
      {
        canonicalDispositionGeneration: options.canonicalGeneration,
        coordinatorIdentity: coordinator.identity,
        kind: 'explicit-transient-pty' as const,
        ptySessionGeneration: options.pty.generation,
        root: options.pty.root,
      },
      () =>
        coordinator.run((access) => {
          const canonical = taskOwner.readTaskContentRootUnderAuthorityCoordinator(
            access,
            options.pty.taskId,
          );
          if (
            canonical.kind !== 'unknown' ||
            canonical.generation !== options.canonicalGeneration
          ) {
            return false;
          }

          const currentPty = readPtyAuthority(access, options.pty.agentId);
          return (
            currentPty?.authorityClass === 'explicit-transient' &&
            currentPty.generation === options.pty.generation &&
            currentPty.root === options.pty.root &&
            currentPty.taskId === options.pty.taskId
          );
        }),
    );
  }

  function beginCanonicalTaskAdmission(taskId: string): PendingTaskContentRootAdmission | null {
    return coordinator.run((access) => {
      const canonical = taskOwner.readTaskContentRootUnderAuthorityCoordinator(access, taskId);
      if (canonical.kind !== 'live') {
        return null;
      }
      return createCanonicalAdmission({
        generation: canonical.generation,
        root: canonical.root,
        taskId,
      });
    });
  }

  function beginTerminalAdmission(request: {
    agentId?: string;
    taskId: string;
  }): PendingTaskContentRootAdmission | null {
    return coordinator.run((access) => {
      const canonical = taskOwner.readTaskContentRootUnderAuthorityCoordinator(
        access,
        request.taskId,
      );
      const pty = request.agentId === undefined ? null : readPtyAuthority(access, request.agentId);
      const exactPty = pty?.taskId === request.taskId ? pty : null;

      if (canonical.kind === 'live') {
        if (exactPty?.authorityClass === 'explicit-transient') {
          return null;
        }
        return createCanonicalAdmission({
          generation: canonical.generation,
          root: canonical.root,
          taskId: request.taskId,
        });
      }

      if (isKnownNonLiveDisposition(canonical)) {
        return null;
      }

      if (exactPty?.authorityClass !== 'explicit-transient') {
        return null;
      }

      return createTransientAdmission({
        canonicalGeneration: canonical.generation,
        pty: exactPty,
      });
    });
  }

  return { beginCanonicalTaskAdmission, beginTerminalAdmission };
}
