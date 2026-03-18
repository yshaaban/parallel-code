import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertBrowserServerBuildArtifactsAreFresh,
  shouldCheckBrowserServerBuildArtifacts,
} from './build-artifacts.js';

async function writeBuildFixture(rootDir: string): Promise<{
  frontendIndexPath: string;
  remoteIndexPath: string;
  serverEntryPath: string;
}> {
  const frontendIndexPath = path.join(rootDir, 'dist', 'index.html');
  const remoteIndexPath = path.join(rootDir, 'dist-remote', 'index.html');
  const serverEntryPath = path.join(rootDir, 'dist-server', 'server', 'main.js');

  await mkdir(path.dirname(frontendIndexPath), { recursive: true });
  await mkdir(path.dirname(remoteIndexPath), { recursive: true });
  await mkdir(path.dirname(serverEntryPath), { recursive: true });

  await Promise.all([
    writeFile(frontendIndexPath, '<html>frontend</html>', 'utf8'),
    writeFile(remoteIndexPath, '<html>remote</html>', 'utf8'),
    writeFile(serverEntryPath, 'console.log("server");', 'utf8'),
  ]);

  return {
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
    await writeSourceFile(rootDir, 'package.json');
    await writeSourceFile(rootDir, 'tsconfig.json');

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
      utimes(path.join(rootDir, 'tsconfig.json'), olderTime, olderTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), newerTime, newerTime),
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
    await writeSourceFile(rootDir, 'package.json');
    await writeSourceFile(rootDir, 'src/App.tsx');
    await writeSourceFile(rootDir, 'server/index.ts');
    await writeSourceFile(rootDir, 'src/ipc/types.ts');
    await writeSourceFile(rootDir, 'src/domain/server-state.ts');
    await writeSourceFile(rootDir, 'electron/ipc/example.ts');
    await writeSourceFile(rootDir, 'tsconfig.json');

    const staleTime = new Date(Date.now() - 10_000);
    const freshTime = new Date(Date.now() + 10_000);
    await Promise.all([
      utimes(remoteIndexPath, staleTime, staleTime),
      utimes(remoteSourcePath, freshTime, freshTime),
      utimes(path.join(rootDir, 'package.json'), staleTime, staleTime),
      utimes(path.join(rootDir, 'dist', 'index.html'), freshTime, freshTime),
      utimes(serverEntryPath, freshTime, freshTime),
    ]);

    await expect(
      assertBrowserServerBuildArtifactsAreFresh({
        projectRoot: rootDir,
        serverEntryPath,
      }),
    ).rejects.toThrow('Browser server remote build artifact is stale.');
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
