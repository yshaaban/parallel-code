import { describe, expect, it } from 'vitest';
import { createTaskContentAuthorityCoordinator } from './task-content-authority-coordinator.js';

describe('task content authority coordinator', () => {
  it('provides access only inside one synchronous critical section', () => {
    const coordinator = createTaskContentAuthorityCoordinator();
    let capturedAccess: Parameters<typeof coordinator.assertAccess>[0] | undefined;

    const result = coordinator.run((access) => {
      capturedAccess = access;
      expect(() => coordinator.assertAccess(access)).not.toThrow();
      return 42;
    });

    expect(result).toBe(42);
    if (!capturedAccess) {
      throw new Error('Expected the coordinator to provide access');
    }
    const expiredAccess = capturedAccess;
    expect(() => coordinator.assertAccess(expiredAccess)).toThrow('not active');
  });

  it('rejects reentrancy without running the nested operation', () => {
    const coordinator = createTaskContentAuthorityCoordinator();
    let nestedRan = false;

    expect(() =>
      coordinator.run(() =>
        coordinator.run(() => {
          nestedRan = true;
        }),
      ),
    ).toThrow('does not allow reentrant access');
    expect(nestedRan).toBe(false);
  });

  it('rejects promise-returning operations and releases the critical section', () => {
    const coordinator = createTaskContentAuthorityCoordinator();

    expect(() => coordinator.run(() => Promise.resolve('invalid'))).toThrow('must be synchronous');
    expect(coordinator.run(() => 'released')).toBe('released');
  });

  it('rejects access from another coordinator instance', () => {
    const first = createTaskContentAuthorityCoordinator();
    const second = createTaskContentAuthorityCoordinator();

    first.run((access) => {
      expect(() => second.assertAccess(access)).toThrow('not active');
    });
  });
});
