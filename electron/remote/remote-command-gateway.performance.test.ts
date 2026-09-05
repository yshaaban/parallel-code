import { describe, expect, it } from 'vitest';
import {
  createRemoteCommandGateway,
  type RemoteCommandAuthentication,
} from '../ipc/remote-command-gateway.js';

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? Infinity;
}

describe('remote command gateway performance', () => {
  it('keeps validation and admission below 2 ms p95 at the body ceiling', async () => {
    const authentication: RemoteCommandAuthentication = {
      authEpoch: 'epoch-1',
      authenticationSessionGeneration: 'generation-1',
      expiresAt: Number.MAX_SAFE_INTEGER,
      grants: new Set(['catalog:read']),
      kind: 'trusted-local',
      principalId: 'workspace-owner',
    };
    const gateway = createRemoteCommandGateway({
      'task-catalog.get-manifest': {
        execute: () => ({ kind: 'ok' }),
        isRequest: (value): value is { padding: string } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { padding?: unknown }).padding === 'string',
        isResult: (value): value is { kind: 'ok' } =>
          typeof value === 'object' &&
          value !== null &&
          (value as { kind?: unknown }).kind === 'ok',
      },
    });
    const request = { padding: 'x'.repeat(1024 * 1024 - 32) };

    for (let index = 0; index < 20; index += 1) {
      await gateway.dispatch(
        'task-catalog.get-manifest',
        authentication,
        request,
        undefined,
        1024 * 1024 - 18,
      );
    }
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      const result = await gateway.dispatch(
        'task-catalog.get-manifest',
        authentication,
        request,
        undefined,
        1024 * 1024 - 18,
      );
      samples.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
    }

    const p95 = percentile(samples, 0.95);
    process.stdout.write(
      `remote gateway 1 MiB validation: n=${samples.length} p95=${p95.toFixed(3)}ms max=${Math.max(...samples).toFixed(3)}ms\n`,
    );
    expect(p95).toBeLessThan(2);
  });
});
