import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getBrowserBuildArtifactStatus,
  runPlaywrightWithBrowserArtifacts,
  shouldCheckBrowserBuildArtifacts,
} from '../../scripts/run-playwright-with-browser-artifacts.mjs';

describe('runPlaywrightWithBrowserArtifacts', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('skips prepare when browser artifacts are already fresh', async () => {
    const runCommand = vi.fn(async () => ({ code: 0, signal: null }));
    const writeLine = vi.fn();

    const exitCode = await runPlaywrightWithBrowserArtifacts({
      args: ['tests/browser/terminal-restore.spec.ts', '--project', 'chromium'],
      getStatus: async () => ({
        checks: [],
        missing: [],
        ok: true,
        stale: [],
      }),
      runCommand,
      writeLine,
    });

    expect(exitCode).toBe(0);
    expect(writeLine).toHaveBeenCalledWith(
      '[browser-artifacts] Browser artifacts are fresh; skipping rebuild.',
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('npx', [
      'playwright',
      'test',
      'tests/browser/terminal-restore.spec.ts',
      '--project',
      'chromium',
    ]);
  });

  it('prepares browser artifacts once before Playwright when artifacts are stale', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, signal: null })
      .mockResolvedValueOnce({ code: 0, signal: null });
    const writeLine = vi.fn();

    const exitCode = await runPlaywrightWithBrowserArtifacts({
      args: ['tests/browser/terminal-input.spec.ts'],
      getStatus: async () => ({
        checks: [],
        missing: [],
        ok: false,
        stale: [
          {
            artifactPath: '/tmp/dist/index.html',
            kind: 'stale' as const,
            label: 'frontend' as const,
            latestSourceFile: { filePath: '/tmp/src/index.tsx', mtimeMs: 10 },
          },
        ],
      }),
      runCommand,
      writeLine,
    });

    expect(exitCode).toBe(0);
    expect(writeLine).toHaveBeenCalledWith(
      '[browser-artifacts] frontend stale; running prepare:browser-artifacts once.',
    );
    expect(runCommand).toHaveBeenNthCalledWith(1, 'npm', ['run', 'prepare:browser-artifacts']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'npx', [
      'playwright',
      'test',
      'tests/browser/terminal-input.spec.ts',
    ]);
  });

  it('skips the artifact precheck when the shared skip env is set', async () => {
    const getStatus = vi.fn();
    const runCommand = vi.fn(async () => ({ code: 0, signal: null }));
    const writeLine = vi.fn();

    const exitCode = await runPlaywrightWithBrowserArtifacts({
      args: ['tests/browser/multiclient-control.spec.ts'],
      env: {
        ...process.env,
        PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1',
      },
      getStatus,
      runCommand,
      writeLine,
    });

    expect(exitCode).toBe(0);
    expect(getStatus).not.toHaveBeenCalled();
    expect(writeLine).toHaveBeenCalledWith(
      '[browser-artifacts] Skipping browser artifact freshness check.',
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('npx', [
      'playwright',
      'test',
      'tests/browser/multiclient-control.spec.ts',
    ]);
  });

  it('stops before Playwright when prepare fails', async () => {
    const runCommand = vi.fn(async () => ({ code: 2, signal: null }));

    const exitCode = await runPlaywrightWithBrowserArtifacts({
      getStatus: async () => ({
        checks: [],
        missing: [
          {
            artifactPath: '/tmp/dist/index.html',
            kind: 'missing' as const,
            label: 'frontend' as const,
          },
        ],
        ok: false,
        stale: [],
      }),
      runCommand,
      writeLine: vi.fn(),
    });

    expect(exitCode).toBe(2);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'prepare:browser-artifacts']);
  });

  it('re-reads version metadata on repeated status checks in the same process', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-artifacts-'));
    tempDirs.push(rootDir);

    const frontendIndexPath = path.join(rootDir, 'dist', 'index.html');
    const frontendMetadataPath = path.join(rootDir, 'dist', 'build-metadata.json');
    const remoteIndexPath = path.join(rootDir, 'dist-remote', 'index.html');
    const serverEntryPath = path.join(rootDir, 'dist-server', 'server', 'main.js');
    await Promise.all([
      mkdir(path.dirname(frontendIndexPath), { recursive: true }),
      mkdir(path.dirname(remoteIndexPath), { recursive: true }),
      mkdir(path.dirname(serverEntryPath), { recursive: true }),
      mkdir(path.join(rootDir, 'src', 'remote'), { recursive: true }),
      mkdir(path.join(rootDir, 'src', 'domain'), { recursive: true }),
      mkdir(path.join(rootDir, 'src', 'ipc'), { recursive: true }),
      mkdir(path.join(rootDir, 'src', 'lib'), { recursive: true }),
      mkdir(path.join(rootDir, 'electron', 'ipc'), { recursive: true }),
      mkdir(path.join(rootDir, 'electron', 'remote'), { recursive: true }),
      mkdir(path.join(rootDir, 'server'), { recursive: true }),
    ]);

    await Promise.all([
      writeFile(frontendIndexPath, '<html>frontend</html>', 'utf8'),
      writeFile(frontendMetadataPath, JSON.stringify({ appVersion: '0.7.0' }), 'utf8'),
      writeFile(remoteIndexPath, '<html>remote</html>', 'utf8'),
      writeFile(serverEntryPath, 'console.log("server");', 'utf8'),
      writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8'),
      writeFile(path.join(rootDir, 'package-lock.json'), '// lock', 'utf8'),
      writeFile(path.join(rootDir, 'tsconfig.json'), '{}', 'utf8'),
      writeFile(path.join(rootDir, 'server', 'tsconfig.json'), '{}', 'utf8'),
      writeFile(path.join(rootDir, 'electron', 'vite.config.electron.ts'), '// vite', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), '// vite', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'App.tsx'), '// app', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'remote', 'App.tsx'), '// remote', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'domain', 'server-state.ts'), '// domain', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'lib', 'assert-never.ts'), '// lib', 'utf8'),
      writeFile(path.join(rootDir, 'electron', 'ipc', 'channels.ts'), '// ipc', 'utf8'),
      writeFile(path.join(rootDir, 'electron', 'remote', 'protocol.ts'), '// remote proto', 'utf8'),
      writeFile(path.join(rootDir, 'server', 'index.ts'), '// server', 'utf8'),
      writeFile(path.join(rootDir, 'src', 'ipc', 'types.ts'), '// ipc types', 'utf8'),
    ]);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'lib', 'assert-never.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'channels.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'remote', 'protocol.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package.json'), newerTime, newerTime),
      utimes(frontendIndexPath, newerTime, newerTime),
      utimes(frontendMetadataPath, newerTime, newerTime),
      utimes(remoteIndexPath, newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const initialStatus = await getBrowserBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });
    expect(initialStatus.ok).toBe(true);

    await Promise.all([
      writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.0' }), 'utf8'),
      writeFile(frontendMetadataPath, JSON.stringify({ appVersion: '0.7.0' }), 'utf8'),
    ]);

    const status = await getBrowserBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(false);
    expect(status.stale[0]?.label).toBe('frontend');
    expect(status.stale[0]?.staleReason).toBe('version-mismatch');
  });
});

describe('shouldCheckBrowserBuildArtifacts', () => {
  it('defaults to checking browser artifacts', () => {
    expect(shouldCheckBrowserBuildArtifacts({})).toBe(true);
  });

  it('honors the shared skip env contract', () => {
    expect(
      shouldCheckBrowserBuildArtifacts({
        PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1',
      }),
    ).toBe(false);
  });
});
