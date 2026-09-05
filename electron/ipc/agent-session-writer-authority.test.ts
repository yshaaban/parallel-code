import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createAgentSessionWriterRuntime,
  type AgentSessionGenerationReservationRequest,
} from './agent-session-writer-authority.js';

function reservation(
  overrides: Partial<AgentSessionGenerationReservationRequest> = {},
): AgentSessionGenerationReservationRequest {
  return {
    agentId: 'agent-1',
    expectedSourceGeneration: null,
    operationId: 'operation-1',
    purpose: 'agent-session-operation',
    targetGeneration: 0,
    taskId: 'task-1',
    ...overrides,
  };
}

describe('agent-session writer authority', () => {
  it('keeps the legacy path open before cutover and requires an opaque permit afterward', () => {
    const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });

    expect(() =>
      writer.assertSpawnPermit(undefined, { agentId: 'agent-1', taskId: 'task-1' }),
    ).not.toThrow();

    writer.activate('cutover-1');
    expect(() =>
      writer.assertSpawnPermit(undefined, { agentId: 'agent-1', taskId: 'task-1' }),
    ).toThrow('requires managed writer admission');
    expect(() =>
      writer.assertSpawnPermit(
        {
          agentId: 'agent-1',
          operationId: 'operation-1',
          targetGeneration: 0,
          taskId: 'task-1',
        },
        { agentId: 'agent-1', taskId: 'task-1' },
      ),
    ).toThrow('stale or mismatched');
  });

  it('allocates only the exact next generation and rejects conflicting reservations', () => {
    const generationByAgent = new Map<string, number>();
    const writer = createAgentSessionWriterRuntime({
      getCurrentGeneration: (agentId) => generationByAgent.get(agentId) ?? null,
    });
    writer.activate('cutover-1');

    expect(writer.allocate(reservation())).toBe('allocated');
    expect(writer.allocate(reservation())).toBe('already-allocated');
    expect(writer.allocate(reservation({ taskId: 'task-other' }))).toBe('stale');
    expect(writer.allocate(reservation({ operationId: 'operation-other' }))).toBe('stale');
    expect(() => writer.allocate(reservation({ targetGeneration: 1 }))).toThrow(
      'not the next generation',
    );
  });

  it('allocates an exact startup target from durable high-water without inventing a live source', () => {
    const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });
    writer.activate('cutover-1');
    const restored = reservation({
      durableSourceGeneration: 7,
      operationId: 'clean-restart-8',
      purpose: 'startup-restore',
      targetGeneration: 8,
    });

    expect(writer.allocate(restored)).toBe('allocated');
    expect(() => writer.allocate({ ...restored, targetGeneration: 9 })).toThrow(
      'not the next generation',
    );
    const { durableSourceGeneration: _durableSourceGeneration, ...withoutDurableSource } = restored;
    expect(() => writer.allocate({ ...withoutDurableSource, expectedSourceGeneration: 7 })).toThrow(
      'no process-local source',
    );
  });

  it('single-flights the admitted process effect and invalidates its permit on settlement', async () => {
    const generationByAgent = new Map<string, number>();
    const writer = createAgentSessionWriterRuntime({
      getCurrentGeneration: (agentId) => generationByAgent.get(agentId) ?? null,
    });
    writer.activate('cutover-1');
    expect(writer.allocate(reservation())).toBe('allocated');

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn(async (permit) => {
      writer.assertSpawnPermit(permit, { agentId: 'agent-1', taskId: 'task-1' });
      await blocked;
      generationByAgent.set('agent-1', 0);
      return 'created';
    });

    const first = writer.executeAllocated('operation-1', effect);
    const second = writer.executeAllocated('operation-1', effect);
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toBe('created');
    expect(effect).toHaveBeenCalledOnce();

    const permit = effect.mock.calls[0]?.[0];
    expect(() =>
      writer.assertSpawnPermit(permit, { agentId: 'agent-1', taskId: 'task-1' }),
    ).toThrow('stale or mismatched');
    expect(writer.allocate(reservation())).toBe('stale');
  });

  it('releases a failed reservation so the exact operation can retry', async () => {
    const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });
    writer.activate('cutover-1');
    expect(writer.allocate(reservation())).toBe('allocated');
    await expect(
      writer.executeAllocated('operation-1', async () => {
        throw new Error('spawn failed');
      }),
    ).rejects.toThrow('spawn failed');
    expect(writer.allocate(reservation())).toBe('allocated');
  });

  it('releases an allocation that is cancelled before its process effect begins', () => {
    const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });
    writer.activate('cutover-1');
    expect(writer.allocate(reservation())).toBe('allocated');
    writer.release('operation-1');
    expect(writer.allocate(reservation({ operationId: 'operation-2' }))).toBe('allocated');
  });

  it('binds one exact cutover epoch', () => {
    const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });
    writer.activate('cutover-1');
    expect(() => writer.verify('cutover-1')).not.toThrow();
    expect(() => writer.activate('cutover-2')).toThrow('another cutover epoch');
    expect(() => writer.verify('cutover-2')).toThrow('mismatched');
  });

  it('keeps every production process-creating call behind the owned workflow', () => {
    const roots = ['electron', 'server'];
    const offenders: string[] = [];
    const visit = (absolute: string): void => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = path.join(absolute, entry.name);
        if (entry.isDirectory()) {
          visit(child);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
        const relative = path.relative(process.cwd(), child);
        if (relative === 'electron/ipc/task-workflows.ts') continue;
        const source = fs.readFileSync(child, 'utf8');
        if (/\bspawnTaskAgentWorkflow\s*\(/u.test(source)) offenders.push(relative);
      }
    };

    for (const root of roots) visit(path.resolve(root));
    expect(offenders).toEqual([]);
  });
});
