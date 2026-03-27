import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertBrowserServerBuildArtifactsAreFresh,
  getBrowserServerBuildArtifactStatus,
  shouldCheckBrowserServerBuildArtifacts,
} from './build-artifacts.js';

async function writeBuildFixture(rootDir: string): Promise<{
  frontendMetadataPath: string;
  frontendIndexPath: string;
  remoteIndexPath: string;
  serverEntryPath: string;
}> {
  const frontendIndexPath = path.join(rootDir, 'dist', 'index.html');
  const frontendMetadataPath = path.join(rootDir, 'dist', 'build-metadata.json');
  const remoteIndexPath = path.join(rootDir, 'dist-remote', 'index.html');
  const serverEntryPath = path.join(rootDir, 'dist-server', 'server', 'main.js');

  await mkdir(path.dirname(frontendIndexPath), { recursive: true });
  await mkdir(path.dirname(remoteIndexPath), { recursive: true });
  await mkdir(path.dirname(serverEntryPath), { recursive: true });

  await Promise.all([
    writeFile(frontendIndexPath, '<html>frontend</html>', 'utf8'),
    writeFile(
      frontendMetadataPath,
      JSON.stringify({
        appVersion: '0.7.0',
        buildStamp: '2026-03-26 00:00:00Z',
      }),
      'utf8',
    ),
    writeFile(remoteIndexPath, '<html>remote</html>', 'utf8'),
    writeFile(serverEntryPath, 'console.log("server");', 'utf8'),
  ]);

  return {
    frontendMetadataPath,
    frontendIndexPath,
    remoteIndexPath,
    serverEntryPath,
  };
}

async function writeSourceFile(rootDir: string, relativePath: string): Promise<string> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '// source', 'utf8');
  return filePath;
}

async function writeBuildMetadataSources(rootDir: string): Promise<void> {
  await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8');
  await writeSourceFile(rootDir, 'package-lock.json');
  await writeSourceFile(rootDir, 'tsconfig.json');
  await writeSourceFile(rootDir, 'server/tsconfig.json');
  await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
  await writeSourceFile(rootDir, 'src/remote/vite.config.ts');
}

describe('assertBrowserServerBuildArtifactsAreFresh', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('accepts current artifacts when source is not newer', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.7.0' }),
      'utf8',
    );
    await writeSourceFile(rootDir, 'package-lock.json');
    await writeSourceFile(rootDir, 'tsconfig.json');
    await writeSourceFile(rootDir, 'server/tsconfig.json');
    await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
    await writeSourceFile(rootDir, 'src/remote/vite.config.ts');

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    await expect(
      assertBrowserServerBuildArtifactsAreFresh({
        projectRoot: rootDir,
        serverEntryPath,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when the remote build artifact is stale', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { remoteIndexPath, serverEntryPath } = await writeBuildFixture(rootDir);
    const remoteSourcePath = await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.7.0' }),
      'utf8',
    );
    await writeSourceFile(rootDir, 'package-lock.json');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeSourceFile(rootDir, 'tsconfig.json');
    await writeSourceFile(rootDir, 'server/tsconfig.json');
    await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
    await writeSourceFile(rootDir, 'src/remote/vite.config.ts');

    const staleTime = new Date(Date.now() - 10_000);
    const freshTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(remoteIndexPath, staleTime, staleTime),
      utimes(remoteSourcePath, freshTime, freshTime),
      utimes(path.join(rootDir, 'package.json'), staleTime, staleTime),
      utimes(path.join(rootDir, 'package-lock.json'), staleTime, staleTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), freshTime, freshTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), freshTime, freshTime),
      utimes(serverEntryPath, freshTime, freshTime),
    ]);

    await expect(
      assertBrowserServerBuildArtifactsAreFresh({
        projectRoot: rootDir,
        serverEntryPath,
      }),
    ).rejects.toThrow('Browser server remote build artifact is stale.');
  });

  it('reports missing and stale checks without throwing', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { frontendMetadataPath, remoteIndexPath, serverEntryPath } =
      await writeBuildFixture(rootDir);
    const frontendSourcePath = await writeSourceFile(rootDir, 'src/App.tsx');
    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.7.0' }),
      'utf8',
    );
    await writeSourceFile(rootDir, 'package-lock.json');
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeSourceFile(rootDir, 'tsconfig.json');
    await writeSourceFile(rootDir, 'server/tsconfig.json');
    await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
    await writeSourceFile(rootDir, 'src/remote/vite.config.ts');

    const staleTime = new Date(Date.now() - 10_000);
    const freshTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(frontendSourcePath, freshTime, freshTime),
      utimes(frontendMetadataPath, staleTime, staleTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), staleTime, staleTime),
      utimes(path.join(rootDir, 'package-lock.json'), staleTime, staleTime),
      utimes(serverEntryPath, freshTime, freshTime),
    ]);
    await rm(remoteIndexPath, { force: true });

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(false);
    expect(status.staleChecks.map((check) => check.label)).toContain('frontend');
    expect(status.missingChecks.map((check) => check.label)).toContain('remote');
  });

  it('does not mark browser artifacts stale for unrelated package.json edits', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.7.0', scripts: { test: 'changed' } }),
      'utf8',
    );
    await writeSourceFile(rootDir, 'package-lock.json');
    await writeSourceFile(rootDir, 'tsconfig.json');
    await writeSourceFile(rootDir, 'server/tsconfig.json');
    await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
    await writeSourceFile(rootDir, 'src/remote/vite.config.ts');

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(true);
  });

  it('does not mark the remote artifact stale for unrelated main-app src changes', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/components/TaskPanel.tsx');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'src/lib/assert-never.ts');
    await writeSourceFile(rootDir, 'electron/ipc/channels.ts');
    await writeSourceFile(rootDir, 'electron/remote/protocol.ts');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeBuildMetadataSources(rootDir);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'components', 'TaskPanel.tsx'), newerTime, newerTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'lib', 'assert-never.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'channels.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'remote', 'protocol.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.staleChecks.map((check) => check.label)).not.toContain('remote');
  });

  it('does not mark the server artifact stale for unrelated electron shell changes', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeSourceFile(rootDir, 'electron/remote/protocol.ts');
    await writeSourceFile(rootDir, 'electron/main.ts');
    await writeBuildMetadataSources(rootDir);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'remote', 'protocol.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'main.ts'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.staleChecks.map((check) => check.label)).not.toContain('server');
  });

  it('marks the server artifact stale when a tracked src/lib dependency changes', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    const sharedServerLibPath = await writeSourceFile(rootDir, 'src/lib/prompt-detection.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeBuildMetadataSources(rootDir);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(sharedServerLibPath, newerTime, newerTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, olderTime, olderTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(false);
    expect(status.staleChecks.map((check) => check.label)).toContain('server');
  });

  it('does not mark browser artifacts stale for benchmark-only source edits', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'src/lib/assert-never.ts');
    const benchmarkPath = await writeSourceFile(
      rootDir,
      'src/app/terminal-output-scheduler.benchmark.ts',
    );
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeBuildMetadataSources(rootDir);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'lib', 'assert-never.ts'), olderTime, olderTime),
      utimes(benchmarkPath, newerTime, newerTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(true);
  });

  it('marks the frontend artifact stale when the built app version does not match package.json', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.8.0' }),
      'utf8',
    );
    await writeSourceFile(rootDir, 'package-lock.json');
    await writeSourceFile(rootDir, 'tsconfig.json');
    await writeSourceFile(rootDir, 'server/tsconfig.json');
    await writeSourceFile(rootDir, 'electron/vite.config.electron.ts');
    await writeSourceFile(rootDir, 'src/remote/vite.config.ts');

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'build-metadata.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(false);
    expect(status.staleChecks[0]?.label).toBe('frontend');
    expect(status.staleChecks[0]?.staleReason).toBe('version-mismatch');
  });

  it('re-reads package metadata on repeated checks in the same process', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-build-artifacts-'));
    tempDirs.push(rootDir);

    const { frontendMetadataPath, serverEntryPath } = await writeBuildFixture(rootDir);
    await writeSourceFile(rootDir, 'src/remote/App.tsx');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeBuildMetadataSources(rootDir);

    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(path.join(rootDir, 'src', 'remote', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'App.tsx'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'index.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'ipc', 'types.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'domain', 'server-state.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'ipc', 'example.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package-lock.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'server', 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'electron', 'vite.config.electron.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'src', 'remote', 'vite.config.ts'), olderTime, olderTime),
      utimes(path.join(rootDir, 'package.json'), newerTime, newerTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
      utimes(frontendMetadataPath, newerTime, newerTime),
      utimes(path.join(rootDir, 'dist-remote', 'index.html'), newerTime, newerTime),
      utimes(serverEntryPath, newerTime, newerTime),
    ]);

    const initialStatus = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });
    expect(initialStatus.ok).toBe(true);

    await writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ version: '0.8.0' }),
      'utf8',
    );
    await writeFile(
      frontendMetadataPath,
      JSON.stringify({
        appVersion: '0.7.0',
        buildStamp: '2026-03-26 00:00:00Z',
      }),
      'utf8',
    );
    await Promise.all([
      utimes(path.join(rootDir, 'package.json'), newerTime, newerTime),
      utimes(frontendMetadataPath, newerTime, newerTime),
    ]);

    const status = await getBrowserServerBuildArtifactStatus({
      projectRoot: rootDir,
      serverEntryPath,
    });

    expect(status.ok).toBe(false);
    expect(status.staleChecks[0]?.label).toBe('frontend');
    expect(status.staleChecks[0]?.staleReason).toBe('version-mismatch');
  });
});

describe('shouldCheckBrowserServerBuildArtifacts', () => {
  it('enforces build freshness by default', () => {
    expect(shouldCheckBrowserServerBuildArtifacts({})).toBe(true);
  });

  it('allows explicit test-mode bypass', () => {
    expect(
      shouldCheckBrowserServerBuildArtifacts({
        PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1',
      }),
    ).toBe(false);
  });
});
