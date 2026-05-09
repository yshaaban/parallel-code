import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXPECTED_ELECTRON_PACKAGE_MAIN,
  REQUIRED_ELECTRON_PACKAGE_FILES,
  findDefaultArchivePath,
  runElectronPackageVerifier,
  verifyArchive,
  verifyElectronArchiveMetadata,
  verifyFreshness,
} from '../../scripts/verify-electron-package.mjs';

function createValidPackageFiles(): Set<string> {
  return new Set(REQUIRED_ELECTRON_PACKAGE_FILES);
}

function createValidPackageJson(): { main: string } {
  return {
    main: EXPECTED_ELECTRON_PACKAGE_MAIN,
  };
}

describe('verify-electron-package', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
    );
  });

  async function createTempReleaseDir(): Promise<string> {
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-release-'));
    tempDirs.push(releaseDir);
    return releaseDir;
  }

  it('accepts the expected packaged Electron, frontend, and remote bundle shape', () => {
    const failures = verifyElectronArchiveMetadata(
      createValidPackageFiles(),
      createValidPackageJson(),
    );

    expect(failures).toEqual([]);
  });

  it('rejects stale entrypoints, missing remote bundles, and packaged test artifacts', () => {
    const files = createValidPackageFiles();
    files.delete('/dist-remote/index.html');
    files.add('/dist-electron/main.js');
    files.add('/dist-electron/electron/main.test.js');
    files.add('/dist-electron/electron/main.spec.mjs');
    files.add('/dist/src/App.test.tsx');
    files.add('/dist-remote/Preview.spec.jsx');

    const failures = verifyElectronArchiveMetadata(files, {
      main: 'dist-electron/main.js',
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        'package.json main expected dist-electron/electron/main.js, got dist-electron/main.js',
        'missing required file: /dist-remote/index.html',
        'found forbidden stale file: /dist-electron/main.js',
        [
          'found packaged test artifacts (4):',
          '/dist-electron/electron/main.spec.mjs',
          '/dist-electron/electron/main.test.js',
          '/dist-remote/Preview.spec.jsx',
          '/dist/src/App.test.tsx',
        ].join('\n'),
      ]),
    );
  });

  it('reads archive contents through injectable asar dependencies', () => {
    const failures = verifyArchive('/tmp/app.asar', {
      extractFile: () => Buffer.from(JSON.stringify(createValidPackageJson())),
      listPackage: () => [...createValidPackageFiles()],
    });

    expect(failures).toEqual([]);
  });

  it('finds the default Linux unpacked archive', async () => {
    const releaseDir = await createTempReleaseDir();
    const archivePath = path.join(releaseDir, 'linux-arm64-unpacked', 'resources', 'app.asar');
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, '');

    await expect(findDefaultArchivePath({ releaseDir })).resolves.toBe(archivePath);
  });

  it('finds the default macOS app-bundle archive', async () => {
    const releaseDir = await createTempReleaseDir();
    const archivePath = path.join(
      releaseDir,
      'mac',
      'Parallel Code.app',
      'Contents',
      'Resources',
      'app.asar',
    );
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, '');

    await expect(findDefaultArchivePath({ releaseDir })).resolves.toBe(archivePath);
  });

  it('requires an explicit archive path when multiple packaged archives exist', async () => {
    const releaseDir = await createTempReleaseDir();
    const linuxArchivePath = path.join(releaseDir, 'linux-arm64-unpacked', 'resources', 'app.asar');
    const macArchivePath = path.join(
      releaseDir,
      'mac',
      'Parallel Code.app',
      'Contents',
      'Resources',
      'app.asar',
    );
    await mkdir(path.dirname(linuxArchivePath), { recursive: true });
    await mkdir(path.dirname(macArchivePath), { recursive: true });
    await writeFile(linuxArchivePath, '');
    await writeFile(macArchivePath, '');

    await expect(findDefaultArchivePath({ releaseDir })).rejects.toThrow(
      'Multiple app.asar archives found; pass one explicitly',
    );
  });

  it('rejects stale or missing build inputs before packaging is considered fresh', async () => {
    const projectRoot = '/repo';
    const archivePath = path.join(projectRoot, 'release/linux-arm64-unpacked/resources/app.asar');
    const missingInput = path.join(projectRoot, 'electron/preload.cjs');
    const staleInput = path.join(projectRoot, 'dist-remote/index.html');

    const failures = await verifyFreshness(archivePath, {
      pathExistsFn: async (filePath: string) => filePath !== missingInput,
      projectRoot,
      statFn: async (filePath: string) => ({
        mtimeMs: filePath === staleInput ? 3_000 : 1_000,
      }),
    });

    expect(failures).toEqual([
      'freshness input is missing: electron/preload.cjs',
      'archive is older than freshness input: dist-remote/index.html',
    ]);
  });

  it('returns archive path and failures without exiting when used as a library', async () => {
    const archivePath = '/repo/release/linux-arm64-unpacked/resources/app.asar';

    const result = await runElectronPackageVerifier(['node', 'script', archivePath], {
      cwd: '/',
      extractFile: () => Buffer.from(JSON.stringify({ main: 'dist-electron/main.js' })),
      listPackage: () => ['/package.json'],
      pathExistsFn: async () => true,
      projectRoot: '/repo',
      statFn: async () => ({ mtimeMs: 1_000 }),
    });

    expect(result.archivePath).toBe(archivePath);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'package.json main expected dist-electron/electron/main.js, got dist-electron/main.js',
        'missing required file: /dist-electron/electron/main.js',
        'missing required file: /electron/preload.cjs',
        'missing required file: /dist/index.html',
        'missing required file: /dist-remote/index.html',
      ]),
    );
  });
});
