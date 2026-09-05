const COORDINATOR_ACCESS = Symbol('task-content-authority-access');

export interface TaskContentAuthorityAccess {
  readonly [COORDINATOR_ACCESS]: symbol;
}

export interface TaskContentAuthorityCoordinator {
  readonly identity: symbol;
  assertAccess(access: TaskContentAuthorityAccess): void;
  run<T>(operation: (access: TaskContentAuthorityAccess) => T): T;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Linearizes task-root and PTY-session authority on the backend owner event loop.
 * The callback must stay synchronous and may only call owner-local authority
 * primitives; filesystem, IPC, events, and application callbacks stay outside.
 */
export function createTaskContentAuthorityCoordinator(): TaskContentAuthorityCoordinator {
  const identity = Symbol('task-content-authority-coordinator');
  const access = Object.freeze({ [COORDINATOR_ACCESS]: identity });
  let active = false;

  function assertAccess(candidate: TaskContentAuthorityAccess): void {
    if (!active || candidate[COORDINATOR_ACCESS] !== identity) {
      throw new Error('Task content authority access is not active for this coordinator');
    }
  }

  function run<T>(operation: (activeAccess: TaskContentAuthorityAccess) => T): T {
    if (active) {
      throw new Error('Task content authority coordinator does not allow reentrant access');
    }

    active = true;
    try {
      const result = operation(access);
      if (isPromiseLike(result)) {
        throw new Error('Task content authority coordinator callbacks must be synchronous');
      }
      return result;
    } finally {
      active = false;
    }
  }

  return { assertAccess, identity, run };
}
