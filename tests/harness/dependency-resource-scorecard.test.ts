import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureScorecard,
  collectResourceSnapshot,
  compareScorecards,
  DEFAULT_SAMPLE_COUNT,
  FRESHNESS_TOLERANCE_MS,
  getCaptureProtocol,
  MAIN_ENTRY_GZIP_BUDGET_BYTES,
  METADATA_COMMAND_TIMEOUT_MS,
  parseScorecardArguments,
  runMetadataCommand,
  runScorecardCli,
  SCORECARD_SCHEMA_VERSION,
  summarizeSamples,
  validateScorecard,
} from '../../scripts/dependency-resource-scorecard.mjs';

const tempDirs: string[] = [];
const HASH = 'a'.repeat(64);

function fileRecord(filePath: string, bytes: number, mtimeMs: number) {
  return { path: filePath, bytes, mtimeMs };
}

type SampleOptions = {
  appAsarBytes?: number;
  frontendBuildMs?: number;
  fullReleaseBuildMs?: number;
  installMs?: number;
  mainBrotliBytes?: number;
  mainGzipBytes?: number;
  mainRawBytes?: number;
  nodeModulesBytes?: number;
  packageBytes?: number;
  remoteBrotliBytes?: number;
  remoteGzipBytes?: number;
  remoteRawBytes?: number;
  remoteBuildMs?: number;
  serverBuildMs?: number;
  unpackedBytes?: number;
};

function createSample(index: number, options: SampleOptions = {}) {
  const startedAtMs = index * 10_000;
  const fullReleaseBuildStartedAtMs = startedAtMs + 1_000;
  const artifactMtimeMs = fullReleaseBuildStartedAtMs + 500;
  const completedAtMs = startedAtMs + 2_000;
  return {
    index,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    fullReleaseBuildStartedAtMs,
    timingsMs: {
      install: options.installMs ?? 10_000,
      frontendBuild: options.frontendBuildMs ?? 2_000,
      remoteBuild: options.remoteBuildMs ?? 1_000,
      serverBuild: options.serverBuildMs ?? 3_000,
      fullReleaseBuild: options.fullReleaseBuildMs ?? 20_000,
    },
    nodeModulesBytes: options.nodeModulesBytes ?? 1_000_000,
    entries: {
      main: {
        html: fileRecord('dist/index.html', 500, artifactMtimeMs),
        raw: fileRecord(
          'dist/assets/index-main.js',
          options.mainRawBytes ?? 500_000,
          artifactMtimeMs,
        ),
        gzip: fileRecord(
          'dist/assets/index-main.js.gz',
          options.mainGzipBytes ?? 200_000,
          artifactMtimeMs,
        ),
        brotli: fileRecord(
          'dist/assets/index-main.js.br',
          options.mainBrotliBytes ?? 180_000,
          artifactMtimeMs,
        ),
      },
      remote: {
        html: fileRecord('dist-remote/index.html', 500, artifactMtimeMs),
        raw: fileRecord(
          'dist-remote/assets/index-remote.js',
          options.remoteRawBytes ?? 300_000,
          artifactMtimeMs,
        ),
        gzip: fileRecord(
          'dist-remote/assets/index-remote.js.gz',
          options.remoteGzipBytes ?? 130_000,
          artifactMtimeMs,
        ),
        brotli: fileRecord(
          'dist-remote/assets/index-remote.js.br',
          options.remoteBrotliBytes ?? 110_000,
          artifactMtimeMs,
        ),
      },
    },
    artifacts: [
      {
        id: 'app-asar:linux-unpacked/resources/app.asar',
        kind: 'app-asar',
        ...fileRecord(
          'release/linux-unpacked/resources/app.asar',
          options.appAsarBytes ?? 10_000_000,
          artifactMtimeMs,
        ),
      },
      {
        id: 'package:parallel-code.AppImage',
        kind: 'package',
        ...fileRecord(
          'release/parallel-code.AppImage',
          options.packageBytes ?? 20_000_000,
          artifactMtimeMs,
        ),
      },
      {
        id: 'unpacked:linux-unpacked',
        kind: 'unpacked',
        ...fileRecord(
          'release/linux-unpacked',
          options.unpackedBytes ?? 30_000_000,
          artifactMtimeMs,
        ),
      },
    ],
  };
}

function createEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    arch: 'arm64',
    cpuModel: 'fixture cpu',
    hostname: 'fixture-host',
    lockfileSha256: HASH,
    logicalCpuCount: 8,
    nodeVersion: 'v24.18.1',
    npmVersion: '11.17.0',
    osRelease: 'fixture-release',
    packageJsonSha256: HASH,
    platform: 'darwin',
    totalMemoryBytes: 16_000_000_000,
    ...overrides,
  };
}

function createScorecardFromSamples(
  label: string,
  samples: ReturnType<typeof createSample>[],
  environmentOverrides: Record<string, unknown> = {},
) {
  const finalSample = samples.at(-1);
  if (!finalSample) throw new Error('Scorecard fixture requires samples.');
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    kind: 'dependency-resource-scorecard',
    label,
    capturedAt: finalSample.completedAt,
    environment: createEnvironment(environmentOverrides),
    protocol: getCaptureProtocol(),
    sampleCount: samples.length,
    samples,
    summary: summarizeSamples(samples),
  };
}

function createScorecard(
  label: string,
  options: SampleOptions = {},
  environmentOverrides: Record<string, unknown> = {},
) {
  return createScorecardFromSamples(
    label,
    Array.from({ length: DEFAULT_SAMPLE_COUNT }, (_, index) => createSample(index + 1, options)),
    environmentOverrides,
  );
}

class FakeMetadataChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function createSnapshot(mtimeMs: number) {
  return {
    entries: {
      main: {
        html: fileRecord('dist/index.html', 500, mtimeMs),
        raw: fileRecord('dist/assets/index-main.js', 500_000, mtimeMs),
        gzip: fileRecord('dist/assets/index-main.js.gz', 200_000, mtimeMs),
        brotli: fileRecord('dist/assets/index-main.js.br', 180_000, mtimeMs),
      },
      remote: {
        html: fileRecord('dist-remote/index.html', 500, mtimeMs),
        raw: fileRecord('dist-remote/assets/index-remote.js', 300_000, mtimeMs),
        gzip: fileRecord('dist-remote/assets/index-remote.js.gz', 130_000, mtimeMs),
        brotli: fileRecord('dist-remote/assets/index-remote.js.br', 110_000, mtimeMs),
      },
    },
    artifacts: createSample(1).artifacts.map((artifact) => ({ ...artifact, mtimeMs })),
  };
}

async function createTempProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-scorecard-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function createScorecardComparisonFixture(
  targetEnvironmentOverrides: Record<string, unknown> = {},
) {
  const projectRoot = await createTempProject();
  const packageJson = '{"name":"scorecard-fixture"}\n';
  const packageLock = '{"lockfileVersion":3,"name":"scorecard-fixture"}\n';
  const baseline = createScorecard(
    'baseline',
    {},
    {
      lockfileSha256: 'b'.repeat(64),
      packageJsonSha256: 'b'.repeat(64),
    },
  );
  const target = createScorecard(
    'target',
    {},
    {
      lockfileSha256: sha256(packageLock),
      packageJsonSha256: sha256(packageJson),
      ...targetEnvironmentOverrides,
    },
  );
  await Promise.all([
    writeFile(path.join(projectRoot, 'package.json'), packageJson),
    writeFile(path.join(projectRoot, 'package-lock.json'), packageLock),
    mkdir(path.join(projectRoot, 'tmp'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectRoot, 'tmp/baseline.json'), JSON.stringify(baseline)),
    writeFile(path.join(projectRoot, 'tmp/target.json'), JSON.stringify(target)),
  ]);
  return projectRoot;
}

async function writeSizedFile(filePath: string, size: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(size, 'x'));
}

async function createArtifactFixture(projectRoot: string) {
  const mainScript = 'assets/index-main.js';
  const remoteScript = 'assets/index-remote.js';
  await Promise.all([
    writeSizedFile(path.join(projectRoot, 'dist/index.html'), 1).then(() =>
      writeFile(
        path.join(projectRoot, 'dist/index.html'),
        `<script type="module" src="./${mainScript}"></script>`,
      ),
    ),
    writeSizedFile(path.join(projectRoot, 'dist', mainScript), 100),
    writeSizedFile(path.join(projectRoot, 'dist', `${mainScript}.gz`), 50),
    writeSizedFile(path.join(projectRoot, 'dist', `${mainScript}.br`), 40),
    writeSizedFile(path.join(projectRoot, 'dist-remote/index.html'), 1).then(() =>
      writeFile(
        path.join(projectRoot, 'dist-remote/index.html'),
        `<script type="module" src = './${remoteScript}'></script>`,
      ),
    ),
    writeSizedFile(path.join(projectRoot, 'dist-remote', remoteScript), 80),
    writeSizedFile(path.join(projectRoot, 'dist-remote', `${remoteScript}.gz`), 35),
    writeSizedFile(path.join(projectRoot, 'dist-remote', `${remoteScript}.br`), 30),
    writeSizedFile(path.join(projectRoot, 'release/linux-unpacked/resources/app.asar'), 1_000),
    writeSizedFile(path.join(projectRoot, 'release/parallel-code.AppImage'), 2_000),
  ]);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('dependency resource scorecard', () => {
  it('aggregates median and worst values across three reproducible samples', () => {
    const samples = [
      createSample(1, { installMs: 30, mainRawBytes: 300 }),
      createSample(2, { installMs: 10, mainRawBytes: 100 }),
      createSample(3, { installMs: 20, mainRawBytes: 200 }),
    ];

    const summary = summarizeSamples(samples);

    expect(summary.timingsMs.install).toEqual({ median: 20, worst: 30 });
    expect(summary.entries.main.rawBytes).toEqual({ median: 200, worst: 300 });
    expect(summary.artifacts[0]).toMatchObject({
      id: 'app-asar:linux-unpacked/resources/app.asar',
      bytes: { median: 10_000_000, worst: 10_000_000 },
    });
  });

  it('treats content-hashed entry filenames as sample evidence, not stable identity', () => {
    const samples = [createSample(1), createSample(2), createSample(3)];
    for (const [index, sample] of samples.entries()) {
      const mainPath = `dist/assets/index-main-${index}.js`;
      const remotePath = `dist-remote/assets/index-remote-${index}.js`;
      sample.entries.main.raw.path = mainPath;
      sample.entries.main.gzip.path = `${mainPath}.gz`;
      sample.entries.main.brotli.path = `${mainPath}.br`;
      sample.entries.remote.raw.path = remotePath;
      sample.entries.remote.gzip.path = `${remotePath}.gz`;
      sample.entries.remote.brotli.path = `${remotePath}.br`;
    }

    expect(summarizeSamples(samples).entries.main.rawBytes).toEqual({
      median: 500_000,
      worst: 500_000,
    });
  });

  it('passes exact growth boundaries and reports ungated owner-build and install-size metrics', () => {
    const baseline = createScorecard('baseline', {
      installMs: 10_000,
      fullReleaseBuildMs: 20_000,
      mainRawBytes: 500_000,
      mainGzipBytes: 200_000,
      mainBrotliBytes: 180_000,
      remoteRawBytes: 300_000,
      remoteGzipBytes: 130_000,
      remoteBrotliBytes: 110_000,
      appAsarBytes: 10_000_000,
      packageBytes: 20_000_000,
      unpackedBytes: 30_000_000,
    });
    const target = createScorecard(
      'target',
      {
        installMs: 11_500,
        fullReleaseBuildMs: 22_000,
        mainRawBytes: 510_000,
        mainGzipBytes: 204_000,
        mainBrotliBytes: 183_600,
        remoteRawBytes: 306_000,
        remoteGzipBytes: 132_600,
        remoteBrotliBytes: 112_200,
        appAsarBytes: 10_300_000,
        packageBytes: 20_600_000,
        unpackedBytes: 30_900_000,
      },
      { lockfileSha256: 'b'.repeat(64), packageJsonSha256: 'b'.repeat(64) },
    );

    const comparison = compareScorecards(baseline, target);

    expect(comparison.passed).toBe(true);
    expect(comparison.checks.every(({ passed }) => passed)).toBe(true);
    expect(comparison.reported).toHaveProperty('nodeModulesBytes');
    expect(comparison.reported).toHaveProperty('frontendBuildDurationMs');
  });

  it('fails every exceeded threshold, including the strict 250 KiB main gzip budget', () => {
    const baseline = createScorecard('baseline');
    const target = createScorecard('target', {
      installMs: 11_501,
      fullReleaseBuildMs: 22_001,
      mainRawBytes: 510_001,
      mainGzipBytes: MAIN_ENTRY_GZIP_BUDGET_BYTES,
      mainBrotliBytes: 183_601,
      remoteRawBytes: 306_001,
      remoteGzipBytes: 132_601,
      remoteBrotliBytes: 112_201,
      appAsarBytes: 10_300_001,
      packageBytes: 20_600_001,
      unpackedBytes: 30_900_001,
    });

    const comparison = compareScorecards(baseline, target);
    const failedIds = comparison.checks.filter(({ passed }) => !passed).map(({ id }) => id);

    expect(comparison.passed).toBe(false);
    expect(failedIds).toEqual([
      'install-duration',
      'full-release-build-duration',
      'main-raw-bytes',
      'main-gzip-bytes',
      'main-brotli-bytes',
      'remote-raw-bytes',
      'remote-gzip-bytes',
      'remote-brotli-bytes',
      'artifact:app-asar:linux-unpacked/resources/app.asar',
      'artifact:package:parallel-code.AppImage',
      'artifact:unpacked:linux-unpacked',
      'main-gzip-budget',
    ]);
  });

  it('treats exactly 250 KiB gzip as over budget even when growth stays within 2%', () => {
    const baseline = createScorecard('baseline', { mainGzipBytes: 251_000 });
    const target = createScorecardFromSamples('target', [
      createSample(1, { mainGzipBytes: 251_000 }),
      createSample(2, { mainGzipBytes: 251_000 }),
      createSample(3, { mainGzipBytes: MAIN_ENTRY_GZIP_BUDGET_BYTES }),
    ]);

    const failedIds = compareScorecards(baseline, target)
      .checks.filter(({ passed }) => !passed)
      .map(({ id }) => id);

    expect(failedIds).toEqual(['main-gzip-budget']);
  });

  it('gates worst byte samples while timing thresholds remain median-based', () => {
    const baseline = createScorecard('baseline');
    const target = createScorecardFromSamples('target', [
      createSample(1),
      createSample(2),
      createSample(3, {
        appAsarBytes: 10_400_000,
        installMs: 20_000,
        fullReleaseBuildMs: 40_000,
        mainRawBytes: 530_000,
      }),
    ]);

    const comparison = compareScorecards(baseline, target);
    const failedIds = comparison.checks.filter(({ passed }) => !passed).map(({ id }) => id);

    expect(failedIds).toEqual([
      'main-raw-bytes',
      'artifact:app-asar:linux-unpacked/resources/app.asar',
    ]);
    expect(comparison.checks.find(({ id }) => id === 'install-duration')).toMatchObject({
      passed: true,
      gateWorst: false,
    });
    expect(comparison.checks.find(({ id }) => id === 'full-release-build-duration')).toMatchObject({
      passed: true,
      gateWorst: false,
    });
  });

  it('fails closed on stale sample data, missing artifacts, and mismatched environments', () => {
    const stale = createScorecard('stale');
    stale.samples[0].entries.main.gzip.mtimeMs =
      stale.samples[0].fullReleaseBuildStartedAtMs - FRESHNESS_TOLERANCE_MS - 1;
    expect(() => validateScorecard(stale)).toThrow('main gzip is stale');

    const staleArtifact = createScorecard('stale-artifact');
    staleArtifact.samples[0].artifacts[0].mtimeMs =
      staleArtifact.samples[0].fullReleaseBuildStartedAtMs - FRESHNESS_TOLERANCE_MS - 1;
    expect(() => validateScorecard(staleArtifact)).toThrow('artifact 1 is stale');

    const inconsistentSummary = createScorecard('inconsistent');
    inconsistentSummary.summary.timingsMs.install = {
      ...inconsistentSummary.summary.timingsMs.install,
      median: inconsistentSummary.summary.timingsMs.install.median + 1,
    };
    expect(() => validateScorecard(inconsistentSummary)).toThrow(
      'summary does not match its samples',
    );

    const baseline = createScorecard('baseline');
    const missingArtifact = createScorecard('target');
    missingArtifact.samples[0].artifacts.splice(1, 1);
    expect(() => compareScorecards(baseline, missingArtifact)).toThrow(
      'Release artifact set changed between samples',
    );

    const mismatchedCompression = createScorecard('mismatched-compression');
    mismatchedCompression.samples[1].entries.main.gzip.path =
      'dist/assets/not-the-main-entry.js.gz';
    expect(() => validateScorecard(mismatchedCompression)).toThrow(
      'main gzip path must match its raw entry path',
    );

    const otherMachine = createScorecard('target', {}, { hostname: 'other-host' });
    expect(() => compareScorecards(baseline, otherMachine)).toThrow(
      'environment mismatch for hostname',
    );
  });

  it('accepts a current target while allowing the baseline package inputs to remain historical', async () => {
    const projectRoot = await createScorecardComparisonFixture();

    await expect(
      runScorecardCli(
        ['compare', '--baseline', 'tmp/baseline.json', '--target', 'tmp/target.json'],
        { projectRoot },
      ),
    ).resolves.toMatchObject({ exitCode: 0, output: expect.stringContaining('Scorecard passed.') });
  });

  it.each([
    ['packageJsonSha256', 'package.json'],
    ['lockfileSha256', 'package-lock.json'],
  ])('rejects a target with a stale %s using actionable output', async (field, fileName) => {
    const projectRoot = await createScorecardComparisonFixture({ [field]: 'c'.repeat(64) });
    const comparison = runScorecardCli(
      ['compare', '--baseline', 'tmp/baseline.json', '--target', 'tmp/target.json'],
      { projectRoot },
    );

    await expect(comparison).rejects.toThrow(
      `Target scorecard is stale for current ${fileName}: captured ${'c'.repeat(64)}, current`,
    );
    await expect(comparison).rejects.toThrow(
      'Recapture the target scorecard after package metadata is frozen.',
    );
  });

  it('collects fresh eager entries and all available Electron artifact classes', async () => {
    const projectRoot = await createTempProject();
    await createArtifactFixture(projectRoot);
    const freshAfterMs = Date.now() - 100;

    const snapshot = await collectResourceSnapshot({ projectRoot, freshAfterMs });

    expect(snapshot.entries.main.raw).toMatchObject({
      path: 'dist/assets/index-main.js',
      bytes: 100,
    });
    expect(snapshot.entries.remote.brotli).toMatchObject({
      path: 'dist-remote/assets/index-remote.js.br',
      bytes: 30,
    });
    expect(snapshot.artifacts.map(({ id, bytes }) => ({ id, bytes }))).toEqual([
      { id: 'app-asar:linux-unpacked/resources/app.asar', bytes: 1_000 },
      { id: 'package:parallel-code.AppImage', bytes: 2_000 },
      { id: 'unpacked:linux-unpacked', bytes: 1_000 },
    ]);
  });

  it('rejects missing and stale compressed entry artifacts', async () => {
    const missingRoot = await createTempProject();
    await createArtifactFixture(missingRoot);
    await rm(path.join(missingRoot, 'dist/assets/index-main.js.br'));
    await expect(
      collectResourceSnapshot({ projectRoot: missingRoot, freshAfterMs: Date.now() - 100 }),
    ).rejects.toThrow('Main renderer eager Brotli entry is missing');

    const staleRoot = await createTempProject();
    await createArtifactFixture(staleRoot);
    const freshAfterMs = Date.now();
    const staleTimeSeconds = (freshAfterMs - FRESHNESS_TOLERANCE_MS - 1_000) / 1_000;
    await utimes(
      path.join(staleRoot, 'dist-remote/assets/index-remote.js.gz'),
      staleTimeSeconds,
      staleTimeSeconds,
    );
    await expect(collectResourceSnapshot({ projectRoot: staleRoot, freshAfterMs })).rejects.toThrow(
      'Remote renderer eager gzip entry is stale',
    );
  });

  it('runs the fixed clean-install/build/release protocol for every capture sample', async () => {
    const runCommand = vi.fn(async () => ({ code: 0, signal: null }));
    const getDirectorySizeBytesFn = vi.fn(async () => 1_000_000);
    const collectResourceSnapshotFn = vi.fn(async ({ freshAfterMs }: { freshAfterMs: number }) =>
      createSnapshot(freshAfterMs),
    );
    let epochMs = 0;
    let monotonicMs = 0;

    const scorecard = await captureScorecard(
      { label: 'fixture', samples: 3 },
      {
        collectResourceSnapshotFn,
        epochNow: () => (epochMs += 1_000),
        getDirectorySizeBytesFn,
        getEnvironmentFn: async () => createEnvironment(),
        monotonicNow: () => (monotonicMs += 10),
        projectRoot: '/fixture',
        runCommand,
      },
    );

    const expectedCommands = getCaptureProtocol().steps.map(({ command, args }) => [command, args]);
    expect(runCommand.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ...expectedCommands,
      ...expectedCommands,
      ...expectedCommands,
    ]);
    expect(getDirectorySizeBytesFn).toHaveBeenCalledTimes(3);
    expect(collectResourceSnapshotFn).toHaveBeenCalledTimes(3);
    expect(scorecard.sampleCount).toBe(3);
    expect(scorecard.summary.timingsMs.install).toEqual({ median: 10, worst: 10 });
  });

  it('stops capture immediately when an owner command fails', async () => {
    const runCommand = vi.fn(async () => ({ code: 2, signal: null }));

    await expect(
      captureScorecard(
        { label: 'fixture', samples: 3 },
        {
          getEnvironmentFn: async () => createEnvironment(),
          monotonicNow: () => 0,
          projectRoot: '/fixture',
          runCommand,
        },
      ),
    ).rejects.toThrow('install failed with exit 2');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['stdout', 'stderr'] as const)('caps npm metadata %s bytes', async (streamName) => {
    const child = new FakeMetadataChild();
    const promise = runMetadataCommand('npm', ['--version'], {
      cwd: '/fixture',
      outputLimitBytes: 4,
      spawnFn: () => child as never,
    });

    child[streamName].write('12345');

    await expect(promise).rejects.toThrow(`npm --version ${streamName} exceeded 4 bytes`);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('enforces a hard deadline for npm metadata collection', async () => {
    const child = new FakeMetadataChild();
    let fireTimeout: (() => void) | undefined;
    const promise = runMetadataCommand('npm', ['--version'], {
      clearTimeoutFn: vi.fn(),
      cwd: '/fixture',
      setTimeoutFn: (callback: () => void) => {
        fireTimeout = callback;
        return 1 as never;
      },
      spawnFn: () => child as never,
      timeoutMs: METADATA_COMMAND_TIMEOUT_MS,
    });

    fireTimeout?.();

    await expect(promise).rejects.toThrow(
      `npm --version exceeded ${METADATA_COMMAND_TIMEOUT_MS}ms`,
    );
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('requires at least three samples and strict capture/compare options', () => {
    expect(() =>
      parseScorecardArguments([
        'capture',
        '--samples',
        '2',
        '--label',
        'baseline',
        '--output',
        'tmp/baseline.json',
      ]),
    ).toThrow('--samples must be an integer of at least 3');
    expect(
      parseScorecardArguments([
        'compare',
        '--baseline',
        'tmp/baseline.json',
        '--target',
        'tmp/target.json',
      ]),
    ).toEqual({
      command: 'compare',
      baseline: 'tmp/baseline.json',
      target: 'tmp/target.json',
    });
    expect(() => parseScorecardArguments(['compare', '--unknown', 'value'])).toThrow(
      'Unknown scorecard option',
    );
  });
});
