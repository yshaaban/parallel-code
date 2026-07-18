import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runIndependentCleanups } from '../../scripts/lib/cleanup-outcome.mjs';
import {
  EXPECTED_ELECTRON_PACKAGE_MAIN,
  RENDERER_BUNDLED_DEPENDENCY_NAMES,
  REQUIRED_ELECTRON_RUNTIME_PACKAGES,
  REQUIRED_HYPHENATED_PRODUCTION_MODULE,
  REQUIRED_ELECTRON_PACKAGE_FILES,
  findDefaultArchivePaths,
  getElectronPackageDevelopmentArtifactExclusions,
  getPackagedElectronRuntimePackages,
  getRequiredDirectRuntimePackageFiles,
  getRequiredElectronRuntimePackages,
  runElectronPackageVerifier,
  verifyArchive,
  verifyElectronArchiveMetadata,
  verifyElectronRuntimePackages,
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
    await runIndependentCleanups(
      'Electron package verifier test temporary directories',
      tempDirs
        .splice(0)
        .map(
          (directoryPath, index) =>
            [
              `remove Electron package verifier temporary directory ${index + 1}`,
              () => rm(directoryPath, { force: true, recursive: true }),
            ] as const,
        ),
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

  it('derives the complete required runtime dependency tree from package-lock metadata', () => {
    expect(
      getRequiredElectronRuntimePackages({
        packages: {
          '': {},
          'node_modules/dev-only': { dev: true, version: '1.0.0' },
          'node_modules/optional-runtime': { optional: true, version: '1.0.0' },
          'node_modules/runtime': { version: '2.0.0' },
          'node_modules/parent/node_modules/runtime': { version: '2.0.0' },
          'node_modules/runtime/node_modules/transitive': {
            dev: false,
            version: '3.0.0',
          },
        },
      }),
    ).toEqual([
      { name: 'runtime', version: '2.0.0' },
      { name: 'transitive', version: '3.0.0' },
    ]);
  });

  it('derives scoped direct runtime dependencies from packaged metadata', () => {
    expect(
      getRequiredDirectRuntimePackageFiles({
        dependencies: {
          '@scope/runtime': '^1.0.0',
          runtime: '^2.0.0',
        },
      }),
    ).toEqual(['/node_modules/@scope/runtime/package.json', '/node_modules/runtime/package.json']);
  });

  it('rejects a declared direct dependency missing from the archive and lock-derived tree', () => {
    const failures = verifyElectronArchiveMetadata(createValidPackageFiles(), {
      ...createValidPackageJson(),
      dependencies: {
        'new-runtime': '^1.0.0',
      },
    });

    expect(failures).toContain(
      'missing packaged runtime dependencies (1):\n/node_modules/new-runtime/package.json',
    );
  });

  it('accepts hoisted duplicates while rejecting missing runtime identities', () => {
    const missingRuntimePackages = REQUIRED_ELECTRON_RUNTIME_PACKAGES.filter(
      (runtimePackage) => runtimePackage.name !== 'node-pty' && runtimePackage.name !== 'mime-db',
    );
    const failures = verifyElectronRuntimePackages(missingRuntimePackages);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('node-pty@1.1.0');
    expect(failures[0]).toContain('mime-db@1.54.0');
    expect(
      verifyElectronRuntimePackages(
        [{ name: 'runtime', version: '1.0.0' }],
        [
          { name: 'runtime', version: '1.0.0' },
          { name: 'runtime', version: '1.0.0' },
        ],
      ),
    ).toEqual([]);
    expect(
      verifyElectronRuntimePackages(
        [{ name: 'runtime', version: '1.0.0' }],
        [{ name: 'runtime', version: '2.0.0' }],
      ),
    ).toEqual(['missing packaged runtime package identities (1):\nruntime@2.0.0']);
  });

  it('reads and deduplicates packaged runtime identities independently of layout', () => {
    const packageFiles = new Set([
      '/node_modules/runtime/package.json',
      '/node_modules/parent/node_modules/runtime/package.json',
      '/node_modules/runtime/dist/package.json',
    ]);
    const packagedRuntimePackages = getPackagedElectronRuntimePackages(packageFiles, (filePath) =>
      Buffer.from(
        JSON.stringify(
          filePath.endsWith('/dist/package.json')
            ? { type: 'module' }
            : { name: 'runtime', version: '1.0.0' },
        ),
      ),
    );

    expect(packagedRuntimePackages).toEqual([{ name: 'runtime', version: '1.0.0' }]);
  });

  it('does not classify ambiguous production module names as development artifacts', () => {
    const files = createValidPackageFiles();
    files.add('/node_modules/dependency/lib/emoji/test/parse.js');
    files.add('/node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.js');
    files.add('/dist-electron/electron/ipc/test-shell-sandbox.js');

    expect(verifyElectronArchiveMetadata(files, createValidPackageJson())).toEqual([]);
  });

  it('does not classify a hyphenated production module as a test artifact', () => {
    const files = createValidPackageFiles();

    expect(verifyElectronArchiveMetadata(files, createValidPackageJson())).toEqual([]);
    expect(files).toContain(`/${REQUIRED_HYPHENATED_PRODUCTION_MODULE}`);
  });

  it('rejects stale entrypoints, missing remote bundles, and packaged development artifacts', () => {
    const files = createValidPackageFiles();
    files.delete('/dist-remote/index.html');
    files.add('/dist-electron/main.js');
    files.add('/dist-electron/electron/main.test.js');
    files.add('/dist-electron/electron/main.spec.mjs');
    files.add('/dist/src/App.test.tsx');
    files.add('/dist-remote/Preview.spec.jsx');
    files.add('/node_modules/dependency/__tests__/fixture.json');
    files.add('/node_modules/dependency/test/render-spec.ts');
    files.add('/node_modules/dependency/tests/helper.js');

    const failures = verifyElectronArchiveMetadata(files, {
      main: 'dist-electron/main.js',
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        'package.json main expected dist-electron/electron/main.js, got dist-electron/main.js',
        'missing required file: /dist-remote/index.html',
        'found forbidden stale file: /dist-electron/main.js',
        [
          'found packaged development artifacts (7):',
          '/dist-electron/electron/main.spec.mjs',
          '/dist-electron/electron/main.test.js',
          '/dist-remote/Preview.spec.jsx',
          '/dist/src/App.test.tsx',
          '/node_modules/dependency/__tests__/fixture.json',
          '/node_modules/dependency/test/render-spec.ts',
          '/node_modules/dependency/tests/helper.js',
        ].join('\n'),
      ]),
    );
  });

  it('rejects generated test outputs, development trees, and known ambiguous dependency files', () => {
    const files = createValidPackageFiles();
    const artifacts = [
      '/node_modules/@braintree/sanitize-url/vitest.config.ts',
      '/node_modules/dependency/node_modules/ajv/.runkit_example.js',
      '/node_modules/cytoscape/.size-snapshot.json',
      '/node_modules/cytoscape/playwright.config.js',
      '/node_modules/cytoscape/src/test.mjs',
      '/node_modules/parent/node_modules/cytoscape-fcose/demo/demo.gif',
      '/dist-electron/electron/coordinator/test-helpers.test-helper.js',
      '/node_modules/dependency/__snapshots__/unit.test.ts.snap',
      '/node_modules/dependency/benchmarks/throughput.ts',
      '/node_modules/dependency/coverage/index.html',
      '/node_modules/dependency/examples/demo.js',
      '/node_modules/dependency/vitest.integration.config.tsx',
      '/node_modules/fast-uri/types/index.test-d.ts',
      '/node_modules/khroma/tasks/benchmark.js',
      '/node_modules/node-pty/deps/winpty/misc/color-test.sh',
      '/node_modules/node-pty/scripts/post-install.js',
      '/node_modules/node-pty/lib/terminal.test.js.map',
      '/node_modules/object-inspect/test-core-js.js',
      '/node_modules/requires-port/test.js',
      '/node_modules/safer-buffer/tests.js',
    ];
    for (const artifact of artifacts) {
      files.add(artifact);
    }

    const failures = verifyElectronArchiveMetadata(files, createValidPackageJson());
    const developmentArtifactFailure = failures.find((failure) =>
      failure.startsWith('found packaged development artifacts'),
    );

    expect(developmentArtifactFailure).toBeDefined();
    for (const artifact of artifacts) {
      expect(developmentArtifactFailure).toContain(artifact);
    }
  });

  it('keeps every rejected development artifact out of the packaged file set', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      build?: { files?: string[] };
    };

    expect(packageJson.build?.files).toEqual(
      expect.arrayContaining(getElectronPackageDevelopmentArtifactExclusions()),
    );
  });

  it('keeps Vite-bundled renderer dependencies out of the Electron Node runtime', () => {
    const files = createValidPackageFiles();
    for (const [index, dependencyName] of RENDERER_BUNDLED_DEPENDENCY_NAMES.entries()) {
      const nesting = index === 0 ? '/node_modules/parent' : '';
      files.add(`${nesting}/node_modules/${dependencyName}/package.json`);
    }

    const failures = verifyElectronArchiveMetadata(files, createValidPackageJson());
    const rendererDependencyFailure = failures.find((failure) =>
      failure.startsWith('found renderer-bundled dependencies'),
    );

    expect(rendererDependencyFailure).toBeDefined();
    for (const dependencyName of RENDERER_BUNDLED_DEPENDENCY_NAMES) {
      expect(rendererDependencyFailure).toContain(`/node_modules/${dependencyName}/package.json`);
    }
  });

  it('classifies renderer-only and type-only packages as development dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    for (const dependencyName of RENDERER_BUNDLED_DEPENDENCY_NAMES) {
      expect(packageJson.dependencies).not.toHaveProperty(dependencyName);
      expect(packageJson.devDependencies).toHaveProperty(dependencyName);
    }
    expect(packageJson.dependencies).not.toHaveProperty('@types/http-proxy');
    expect(packageJson.devDependencies).toHaveProperty('@types/http-proxy');
  });

  it('reads archive contents through injectable asar dependencies', () => {
    const failures = verifyArchive('/tmp/app.asar', {
      extractFile: () => Buffer.from(JSON.stringify(createValidPackageJson())),
      listPackage: () => [...createValidPackageFiles()],
      requiredRuntimePackages: [],
    });

    expect(failures).toEqual([]);
  });

  it('finds the default Linux unpacked archive', async () => {
    const releaseDir = await createTempReleaseDir();
    const archivePath = path.join(releaseDir, 'linux-arm64-unpacked', 'resources', 'app.asar');
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, '');

    await expect(findDefaultArchivePaths({ releaseDir })).resolves.toEqual([archivePath]);
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

    await expect(findDefaultArchivePaths({ releaseDir })).resolves.toEqual([archivePath]);
  });

  it('finds every packaged archive in deterministic order', async () => {
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

    await expect(findDefaultArchivePaths({ releaseDir })).resolves.toEqual([
      linuxArchivePath,
      macArchivePath,
    ]);
  });

  it('verifies every discovered archive and keeps failures associated with their archive', async () => {
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
    const verifyElectronPackageFn = vi.fn(async (archivePath: string) =>
      archivePath === macArchivePath ? ['mac failure'] : [],
    );

    const result = await runElectronPackageVerifier(['node', 'script'], {
      releaseDir,
      verifyElectronPackageFn,
    });

    expect(verifyElectronPackageFn).toHaveBeenNthCalledWith(
      1,
      linuxArchivePath,
      expect.any(Object),
    );
    expect(verifyElectronPackageFn).toHaveBeenNthCalledWith(2, macArchivePath, expect.any(Object));
    expect(result.archiveResults).toEqual([
      { archivePath: linuxArchivePath, failures: [] },
      { archivePath: macArchivePath, failures: ['mac failure'] },
    ]);
  });

  it('continues verifying other archives when one archive throws', async () => {
    const releaseDir = await createTempReleaseDir();
    const firstArchivePath = path.join(releaseDir, 'first', 'app.asar');
    const secondArchivePath = path.join(releaseDir, 'second', 'app.asar');
    await mkdir(path.dirname(firstArchivePath), { recursive: true });
    await mkdir(path.dirname(secondArchivePath), { recursive: true });
    await writeFile(firstArchivePath, '');
    await writeFile(secondArchivePath, '');
    const verifyElectronPackageFn = vi.fn(async (archivePath: string) => {
      if (archivePath === firstArchivePath) {
        throw new Error('corrupt archive');
      }
      return ['second failure'];
    });

    const result = await runElectronPackageVerifier(['node', 'script'], {
      releaseDir,
      verifyElectronPackageFn,
    });

    expect(verifyElectronPackageFn).toHaveBeenCalledTimes(2);
    expect(result.archiveResults).toEqual([
      { archivePath: firstArchivePath, failures: ['verification error: corrupt archive'] },
      { archivePath: secondArchivePath, failures: ['second failure'] },
    ]);
  });

  it('rejects stale or missing build inputs before packaging is considered fresh', async () => {
    const projectRoot = await createTempReleaseDir();
    const archivePath = path.join(projectRoot, 'release/linux-arm64-unpacked/resources/app.asar');
    const inputPaths = [
      'package.json',
      'package-lock.json',
      'dist/index.html',
      'dist/assets/app.hash.js',
      'dist-electron/electron/main.js',
      'dist-electron/electron/ipc/pty.js',
      'dist-remote/index.html',
      'vendor/hydra/lib/hydra.mjs',
    ];
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, '');
    for (const relativeInputPath of inputPaths) {
      const inputPath = path.join(projectRoot, relativeInputPath);
      await mkdir(path.dirname(inputPath), { recursive: true });
      await writeFile(inputPath, '');
      await utimes(inputPath, 1, 1);
    }
    await utimes(archivePath, 1, 1);
    await utimes(path.join(projectRoot, 'dist/assets/app.hash.js'), 3, 3);
    await utimes(path.join(projectRoot, 'dist-electron/electron/ipc/pty.js'), 4, 4);

    const failures = await verifyFreshness(archivePath, {
      projectRoot,
    });

    expect(failures).toEqual([
      'freshness input is missing: electron/preload.cjs',
      'archive is older than freshness input: dist/assets/app.hash.js',
      'archive is older than freshness input: dist-electron/electron/ipc/pty.js',
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
      readdirFn: async () => [],
      statFn: async () => ({ mtimeMs: 1_000 }),
    });

    expect(result.archiveResults).toHaveLength(1);
    expect(result.archiveResults[0]?.archivePath).toBe(archivePath);
    expect(result.archiveResults[0]?.failures).toEqual(
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
