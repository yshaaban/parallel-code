import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { createTerminalContentRootAuthority } from '../electron/ipc/terminal-root-authority.js';
import type { PtyContentAuthoritySnapshot } from '../electron/ipc/pty.js';
import { createTaskContentAuthorityCoordinator } from './task-content-authority-coordinator.js';
import { createTaskNameRegistry } from './task-names.js';

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Infinity;
}

describe('task content authority coordinator benchmark', () => {
  it('keeps a 64-client mixed begin/commit/transition fixture within its latency budget', () => {
    const coordinator = createTaskContentAuthorityCoordinator();
    const tasks = createTaskNameRegistry(coordinator);
    const ptys = new Map<string, PtyContentAuthoritySnapshot>();
    for (let client = 0; client < 64; client += 1) {
      if (client % 2 === 0) {
        tasks.registerCreatedTask(`task-${client}`, { worktreePath: `/tmp/task-${client}` });
      } else {
        ptys.set(`agent-${client}`, {
          agentId: `agent-${client}`,
          authorityClass: 'explicit-transient',
          generation: 1n,
          root: `/tmp/task-${client}`,
          taskId: `task-${client}`,
        });
      }
    }
    const authority = createTerminalContentRootAuthority(tasks, (access, agentId) => {
      coordinator.assertAccess(access);
      return ptys.get(agentId) ?? null;
    });
    const holdSamples: number[] = [];
    const operationSamples: number[] = [];
    const iterations = 20_000;

    for (let index = 0; index < iterations; index += 1) {
      const client = index % 64;
      const taskId = `task-${client}`;
      const startedAt = performance.now();
      switch (index % 4) {
        case 0:
          authority.beginCanonicalTaskAdmission(taskId)?.commitAfterDescriptorBind();
          break;
        case 1:
          authority
            .beginTerminalAdmission({ agentId: `agent-${client}`, taskId })
            ?.commitAfterDescriptorBind();
          break;
        case 2:
          tasks.markTaskClosing(taskId);
          tasks.registerCreatedTask(taskId, { worktreePath: `/tmp/task-${client}` });
          break;
        case 3:
          coordinator.run(() => {
            const current = ptys.get(`agent-${client}`);
            if (current) {
              ptys.set(`agent-${client}`, { ...current, generation: current.generation + 1n });
            }
          });
          break;
      }
      operationSamples.push(performance.now() - startedAt);

      const holdStartedAt = performance.now();
      coordinator.run(() => undefined);
      holdSamples.push(performance.now() - holdStartedAt);
    }

    expect(percentile(holdSamples, 0.99)).toBeLessThanOrEqual(0.25);
    expect(percentile(operationSamples, 0.99)).toBeLessThanOrEqual(1);
  });
});
