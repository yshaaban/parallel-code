import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  AuditOperationalError,
  createAuditMachineReport,
  evaluateDependencyAudit,
  formatAuditSummary,
  parseAuditJson,
  queryAuditWithRetry,
  resolveAuditOutputPath,
  runDependencyAudit,
  runNpmAuditAttempt,
} from '../../scripts/audit-dependencies.mjs';
import { classifyDependencyExposure } from '../../scripts/lib/dependency-exposure.mjs';

function createLock() {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { server: '1.0.0' },
        devDependencies: { renderer: '1.0.0', tooling: '1.0.0' },
      },
      'node_modules/server': {
        version: '1.0.0',
        dependencies: { shared: '1.0.0' },
      },
      'node_modules/renderer': {
        version: '1.0.0',
        dependencies: { shared: '1.0.0' },
      },
      'node_modules/tooling': { version: '1.0.0' },
      'node_modules/shared': { version: '1.0.0' },
    },
  };
}

function createAuditReport(
  vulnerabilities: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: {} },
  };
}

function vulnerability(nodePath: string, severity: string) {
  return {
    name: nodePath.split('/').at(-1),
    severity,
    via: [
      {
        source: 123,
        title: 'fixture advisory',
        url: 'https://example.invalid/advisory/123',
        severity,
      },
    ],
    effects: [],
    range: '*',
    nodes: [nodePath],
    fixAvailable: true,
  };
}

class FakeAuditChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  });
}

describe('dependency audit policy', () => {
  it('blocks moderate shipped exposure while reporting tooling moderate findings', () => {
    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });
    const report = evaluateDependencyAudit(
      createAuditReport({
        renderer: vulnerability('node_modules/renderer', 'moderate'),
        tooling: vulnerability('node_modules/tooling', 'moderate'),
      }),
      exposure,
    );

    expect(report.passed).toBe(false);
    expect(report.policyFailures).toHaveLength(1);
    expect(report.policyFailures[0]).toMatchObject({
      nodePath: 'node_modules/renderer',
      primaryExposure: 'renderer-shipped',
      severity: 'moderate',
    });
    expect(report.counts.tooling.moderate).toBe(1);
    expect(formatAuditSummary(report)).toContain('Policy failed with 1 vulnerable installed node');
  });

  it('blocks high findings in tooling and retains every shared membership path', () => {
    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });
    const report = evaluateDependencyAudit(
      createAuditReport({ shared: vulnerability('node_modules/shared', 'high') }),
      exposure,
    );

    expect(report.policyFailures[0].memberships.map(({ lane }) => lane)).toEqual([
      'backend-runtime',
      'renderer-shipped',
      'tooling',
    ]);
    expect(formatAuditSummary(report)).toContain(
      'backend-runtime: node_modules/server -> node_modules/shared',
    );
  });

  it('fails closed for an audit node outside the lock graph', () => {
    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });

    expect(() =>
      evaluateDependencyAudit(
        createAuditReport({ missing: vulnerability('node_modules/missing', 'low') }),
        exposure,
      ),
    ).toThrow('Audit node is absent from the classified lock graph: node_modules/missing');
  });

  it('validates audit report shape and severity', () => {
    expect(() => parseAuditJson('{')).toThrow('npm audit returned invalid JSON');
    expect(() => parseAuditJson(JSON.stringify({ auditReportVersion: 1 }))).toThrow(
      'npm audit report version must be 2',
    );

    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });
    expect(() =>
      evaluateDependencyAudit(
        createAuditReport({ server: vulnerability('node_modules/server', 'unknown') }),
        exposure,
      ),
    ).toThrow('unknown severity');
  });

  it('does not retry a valid vulnerability result even when npm exits nonzero', async () => {
    const runAttempt = vi.fn().mockResolvedValue({
      code: 1,
      signal: null,
      stdout: JSON.stringify(
        createAuditReport({ server: vulnerability('node_modules/server', 'high') }),
      ),
      stderr: '',
    });
    const waitFn = vi.fn();

    const result = await queryAuditWithRetry({ runAttempt, waitFn });

    expect(result.attempts).toBe(1);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(waitFn).not.toHaveBeenCalled();
  });

  it('retries one operational failure after the exact delay', async () => {
    const runAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AuditOperationalError('registry unavailable'))
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: JSON.stringify(createAuditReport()),
        stderr: '',
      });
    const waitFn = vi.fn().mockResolvedValue(undefined);

    const result = await queryAuditWithRetry({ runAttempt, waitFn });

    expect(result.attempts).toBe(2);
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(waitFn).toHaveBeenCalledWith(1_000);
  });

  it('fails after two operational attempts', async () => {
    const runAttempt = vi.fn().mockRejectedValue(new AuditOperationalError('offline'));

    await expect(
      queryAuditWithRetry({ runAttempt, waitFn: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow('npm audit failed after 2 attempts: offline');
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it('retries malformed, unsupported, or explicit npm operational output once', async () => {
    const reports = [
      '{',
      JSON.stringify({ auditReportVersion: 1 }),
      JSON.stringify({ auditReportVersion: 2 }),
      JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'registry unavailable' } }),
    ];

    for (const stdout of reports) {
      const runAttempt = vi
        .fn()
        .mockResolvedValueOnce({ code: 1, signal: null, stdout, stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          signal: null,
          stdout: JSON.stringify(createAuditReport()),
          stderr: '',
        });
      const waitFn = vi.fn().mockResolvedValue(undefined);

      await expect(queryAuditWithRetry({ runAttempt, waitFn })).resolves.toMatchObject({
        attempts: 2,
      });
      expect(waitFn).toHaveBeenCalledWith(1_000);
    }
  });

  it.each([
    { code: 2, signal: null, expected: 'exit code 2' },
    { code: null, signal: 'SIGTERM', expected: 'signal SIGTERM' },
  ])('retries an audit process failure reported as $expected', async (failure) => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ ...failure, stdout: '', stderr: 'failed' })
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: JSON.stringify(createAuditReport()),
        stderr: '',
      });
    const waitFn = vi.fn().mockResolvedValue(undefined);

    await expect(queryAuditWithRetry({ runAttempt, waitFn })).resolves.toMatchObject({
      attempts: 2,
    });
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(waitFn).toHaveBeenCalledWith(1_000);
  });

  it.each(['stdout', 'stderr'] as const)('caps captured %s bytes', async (streamName) => {
    const child = new FakeAuditChild();
    const promise = runNpmAuditAttempt({
      outputLimitBytes: 4,
      spawnFn: () => child as never,
    });

    child[streamName].write('12345');

    await expect(promise).rejects.toThrow(`npm audit ${streamName} exceeded 4 bytes`);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('classifies a synchronous process launch failure as operational', async () => {
    await expect(
      runNpmAuditAttempt({
        spawnFn: () => {
          throw new Error('spawn unavailable');
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuditOperationalError',
      message: 'Could not start npm audit: spawn unavailable',
    });
  });

  it('terminates an audit attempt at its deadline', async () => {
    const child = new FakeAuditChild();
    let fireTimeout: (() => void) | undefined;
    const promise = runNpmAuditAttempt({
      timeoutMs: 60_000,
      spawnFn: () => child as never,
      setTimeoutFn: (callback: () => void) => {
        fireTimeout = callback;
        return 1 as never;
      },
      clearTimeoutFn: vi.fn(),
    });

    fireTimeout?.();

    await expect(promise).rejects.toThrow('npm audit exceeded 60000ms');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles at the deadline even when the child never emits close', async () => {
    const child = new FakeAuditChild();
    child.kill = vi.fn(() => true);
    let fireTimeout: (() => void) | undefined;
    const promise = runNpmAuditAttempt({
      timeoutMs: 60_000,
      spawnFn: () => child as never,
      setTimeoutFn: (callback: () => void) => {
        fireTimeout = callback;
        return 1 as never;
      },
      clearTimeoutFn: vi.fn(),
    });

    fireTimeout?.();

    await expect(promise).rejects.toThrow('npm audit exceeded 60000ms');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('deduplicates advisory references by rendered URL', () => {
    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });
    const vulnerable = vulnerability('node_modules/server', 'high');
    vulnerable.via.push({
      source: 456,
      title: 'same advisory from another source id',
      url: 'https://example.invalid/advisory/123',
      severity: 'high',
    });
    const report = evaluateDependencyAudit(createAuditReport({ server: vulnerable }), exposure);

    expect(
      formatAuditSummary(report).match(/https:\/\/example\.invalid\/advisory\/123/gu),
    ).toHaveLength(1);
  });

  it('restricts machine output to JSON artifacts under tmp', () => {
    expect(resolveAuditOutputPath('tmp/audit.json', '/project')).toBe('/project/tmp/audit.json');
    for (const outputPath of [
      'audit.json',
      '../audit.json',
      'tmp',
      'tmp/audit.txt',
      '/absolute/audit.json',
    ]) {
      expect(() => resolveAuditOutputPath(outputPath, '/project')).toThrow(
        '--json-output must be a JSON artifact path inside tmp/',
      );
    }
  });

  it('builds stable machine metadata and propagates artifact write failures', async () => {
    const lockBytes = Buffer.from(JSON.stringify(createLock()));
    const exposure = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });
    const evaluation = evaluateDependencyAudit(createAuditReport(), exposure);
    const metadata = {
      evaluation,
      attempts: 1,
      generatedAt: '2026-08-03T00:00:00.000Z',
      nodeVersion: 'v24.19.0',
      npmVersion: '11.17.0',
      lockBytes,
    };

    expect(JSON.stringify(createAuditMachineReport(metadata))).toBe(
      JSON.stringify(createAuditMachineReport(metadata)),
    );
    expect(createAuditMachineReport(metadata)).toMatchObject({
      generatedAt: '2026-08-03T00:00:00.000Z',
      nodeVersion: 'v24.19.0',
      npmVersion: '11.17.0',
      attempts: 1,
      lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const writeFileFn = vi.fn().mockRejectedValue(new Error('disk full'));
    await expect(
      runDependencyAudit({
        argv: ['node', 'audit-dependencies.mjs', '--json-output', 'tmp/audit.json'],
        cwd: '/project',
        readFileFn: vi.fn().mockResolvedValue(lockBytes),
        mkdirFn: vi.fn().mockResolvedValue(undefined),
        writeFileFn,
        queryAudit: vi.fn().mockResolvedValue({
          auditReport: createAuditReport(),
          attempts: 1,
        }),
        npmVersion: '11.17.0',
        now: () => new Date('2026-08-03T00:00:00.000Z'),
        rendererRoots: ['renderer'],
      }),
    ).rejects.toThrow('disk full');
    expect(writeFileFn).toHaveBeenCalledTimes(1);
  });
});
