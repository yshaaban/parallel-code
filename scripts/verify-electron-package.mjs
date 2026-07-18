#!/usr/bin/env node

import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const sourcePackageLock = require('../package-lock.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
export const EXPECTED_ELECTRON_PACKAGE_MAIN = 'dist-electron/electron/main.js';
export const REQUIRED_HYPHENATED_PRODUCTION_MODULE =
  'dist-electron/src/domain/coordinator-workflow-spec.js';
export const REQUIRED_ELECTRON_PACKAGE_FILES = [
  '/package.json',
  `/${EXPECTED_ELECTRON_PACKAGE_MAIN}`,
  `/${REQUIRED_HYPHENATED_PRODUCTION_MODULE}`,
  '/electron/preload.cjs',
  '/dist/index.html',
  '/dist-remote/index.html',
];
export const FORBIDDEN_ELECTRON_PACKAGE_FILES = ['/dist-electron/main.js'];
export const RENDERER_BUNDLED_DEPENDENCY_NAMES = [
  '@xterm/addon-fit',
  '@xterm/addon-web-links',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'marked',
  'mermaid',
  'monaco-editor',
  'qrcode',
  'shiki',
  'solid-js',
];
export const DEVELOPMENT_ARTIFACT_FILE_KINDS = [
  'bench',
  'benchmark',
  'spec',
  'test',
  'test-helper',
];
export const DEVELOPMENT_ARTIFACT_CODE_EXTENSIONS = [
  'cjs',
  'cts',
  'js',
  'jsx',
  'mjs',
  'mts',
  'ts',
  'tsx',
];
export const DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSIONS = ['cts', 'mts', 'ts'];
// A singular `test` path is not inherently a test suite: some dependencies export production
// modules from such directories. Hyphenated names are also ambiguous (`workflow-spec` is a real
// production module), so only reject them when both signals occur together.
export const DEVELOPMENT_ARTIFACT_DIRECTORY_NAMES = [
  '__mocks__',
  '__snapshots__',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
  'example',
  'examples',
  'playwright-tests',
  'spec',
  'specs',
  'test-results',
  'tests',
  'tests-examples',
];
export const DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_PATHS = [
  'node_modules/ajv/.runkit_example.js',
  'node_modules/cytoscape/src/test.mjs',
  'node_modules/khroma/tasks/benchmark.js',
  'node_modules/node-pty/deps/winpty/misc/color-test.sh',
  'node_modules/object-inspect/test-core-js.js',
  'node_modules/requires-port/test.js',
  'node_modules/safer-buffer/tests.js',
];
export const DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_DIRECTORIES = [
  'node_modules/cytoscape-fcose/demo',
  'node_modules/node-pty/scripts',
];
const DEVELOPMENT_ARTIFACT_KIND_PATTERN = DEVELOPMENT_ARTIFACT_FILE_KINDS.join('|');
const DEVELOPMENT_ARTIFACT_CODE_EXTENSION_PATTERN = DEVELOPMENT_ARTIFACT_CODE_EXTENSIONS.join('|');
const DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSION_PATTERN =
  DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSIONS.join('|');
const DEVELOPMENT_ARTIFACT_FILE_PATTERN = new RegExp(
  `(?:\\.(?:${DEVELOPMENT_ARTIFACT_KIND_PATTERN})\\.(?:${DEVELOPMENT_ARTIFACT_CODE_EXTENSION_PATTERN})|\\.(?:${DEVELOPMENT_ARTIFACT_KIND_PATTERN})(?:\\.d\\.|-d\\.)(?:${DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSION_PATTERN}))(?:\\.map)?$`,
  'u',
);
const SCOPED_HYPHENATED_DEVELOPMENT_ARTIFACT_PATTERN = new RegExp(
  `(?:^|/)test/(?:.*-)(?:${DEVELOPMENT_ARTIFACT_KIND_PATTERN})(?:\\.(?:${DEVELOPMENT_ARTIFACT_CODE_EXTENSION_PATTERN})|(?:\\.d\\.|-d\\.)(?:${DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSION_PATTERN}))(?:\\.map)?$`,
  'u',
);
const DEVELOPMENT_ARTIFACT_DIRECTORY_PATTERN = new RegExp(
  `(?:^|/)(?:${DEVELOPMENT_ARTIFACT_DIRECTORY_NAMES.join('|')})(?:/|$)`,
  'u',
);
const DEVELOPMENT_RUNNER_CONFIG_PATTERN = new RegExp(
  `(?:^|/)(?:playwright|vitest)(?:[-.][^/]*)?\\.(?:config|workspace)\\.(?:${DEVELOPMENT_ARTIFACT_CODE_EXTENSION_PATTERN})$`,
  'u',
);
const HIDDEN_DEVELOPMENT_ARTIFACT_FILE_PATTERN = /(?:^|\/)\.size-snapshot\.json$/u;
const DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_PATH_SUFFIXES =
  DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_PATHS.map((filePath) => `/${filePath}`);
const DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_DIRECTORY_SEGMENTS =
  DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_DIRECTORIES.map((directoryPath) => `/${directoryPath}/`);
export const ELECTRON_PACKAGE_FRESHNESS_FILES = [
  'package.json',
  'package-lock.json',
  'electron/preload.cjs',
];
export const ELECTRON_PACKAGE_FRESHNESS_DIRECTORIES = [
  'dist',
  'dist-electron',
  'dist-remote',
  'vendor/hydra',
];
export const ELECTRON_PACKAGE_FRESHNESS_INPUTS = [
  ...ELECTRON_PACKAGE_FRESHNESS_FILES,
  ...ELECTRON_PACKAGE_FRESHNESS_DIRECTORIES,
];
const FRESHNESS_TOLERANCE_MS = 1_000;
const RENDERER_BUNDLED_DEPENDENCY_SEGMENTS = RENDERER_BUNDLED_DEPENDENCY_NAMES.map(
  (dependencyName) => `/node_modules/${dependencyName}/`,
);

function getLockPackageName(packagePath) {
  return packagePath.split('node_modules/').at(-1);
}

function getRuntimePackageIdentity(runtimePackage) {
  return `${runtimePackage.name}@${runtimePackage.version}`;
}

export function getRequiredElectronRuntimePackages(packageLock = sourcePackageLock) {
  const packages = packageLock?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error('package-lock.json does not contain a packages map.');
  }

  const runtimePackages = Object.entries(packages)
    .filter(
      ([packagePath, metadata]) =>
        packagePath.includes('node_modules/') &&
        metadata !== null &&
        typeof metadata === 'object' &&
        metadata.dev !== true &&
        metadata.optional !== true,
    )
    .map(([packagePath, metadata]) => ({
      name: getLockPackageName(packagePath),
      version: metadata.version,
    }));
  const invalidPackage = runtimePackages.find(
    (runtimePackage) =>
      typeof runtimePackage.name !== 'string' || typeof runtimePackage.version !== 'string',
  );
  if (invalidPackage) {
    throw new Error('A production package-lock entry is missing its name or version.');
  }

  return [
    ...new Map(
      runtimePackages.map((runtimePackage) => [
        getRuntimePackageIdentity(runtimePackage),
        runtimePackage,
      ]),
    ).values(),
  ].sort((left, right) =>
    getRuntimePackageIdentity(left).localeCompare(getRuntimePackageIdentity(right)),
  );
}

export const REQUIRED_ELECTRON_RUNTIME_PACKAGES = getRequiredElectronRuntimePackages();

export function getRequiredDirectRuntimePackageFiles(packageJson) {
  const dependencies = packageJson?.dependencies ?? {};
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('Packaged package.json dependencies must be an object.');
  }

  return Object.keys(dependencies)
    .map((dependencyName) => `/node_modules/${dependencyName}/package.json`)
    .sort();
}

export function getElectronPackageDevelopmentArtifactExclusions() {
  const kindGlob = `{${DEVELOPMENT_ARTIFACT_FILE_KINDS.join(',')}}`;
  const codeExtensionGlob = `{${DEVELOPMENT_ARTIFACT_CODE_EXTENSIONS.join(',')}}`;
  const declarationExtensionGlob = `{${DEVELOPMENT_ARTIFACT_DECLARATION_EXTENSIONS.join(',')}}`;
  return [
    `!**/*.${kindGlob}.${codeExtensionGlob}`,
    `!**/*.${kindGlob}.${codeExtensionGlob}.map`,
    `!**/*.${kindGlob}.d.${declarationExtensionGlob}`,
    `!**/*.${kindGlob}.d.${declarationExtensionGlob}.map`,
    `!**/*.${kindGlob}-d.${declarationExtensionGlob}`,
    `!**/*.${kindGlob}-d.${declarationExtensionGlob}.map`,
    `!**/test/**/*-${kindGlob}.${codeExtensionGlob}`,
    `!**/test/**/*-${kindGlob}.${codeExtensionGlob}.map`,
    `!**/test/**/*-${kindGlob}.d.${declarationExtensionGlob}`,
    `!**/test/**/*-${kindGlob}.d.${declarationExtensionGlob}.map`,
    `!**/test/**/*-${kindGlob}-d.${declarationExtensionGlob}`,
    `!**/test/**/*-${kindGlob}-d.${declarationExtensionGlob}.map`,
    `!**/{playwright,vitest}{,-*,.*}.{config,workspace}.${codeExtensionGlob}`,
    '!**/.size-snapshot.json',
    ...DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_PATHS.map((filePath) => `!**/${filePath}`),
    ...DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_DIRECTORIES.flatMap((directoryPath) => [
      `!**/${directoryPath}`,
      `!**/${directoryPath}/**`,
    ]),
    ...DEVELOPMENT_ARTIFACT_DIRECTORY_NAMES.flatMap((directoryName) => [
      `!**/${directoryName}`,
      `!**/${directoryName}/**`,
    ]),
  ];
}

function isDevelopmentArtifactPath(filePath) {
  return (
    DEVELOPMENT_ARTIFACT_FILE_PATTERN.test(filePath) ||
    SCOPED_HYPHENATED_DEVELOPMENT_ARTIFACT_PATTERN.test(filePath) ||
    DEVELOPMENT_ARTIFACT_DIRECTORY_PATTERN.test(filePath) ||
    DEVELOPMENT_RUNNER_CONFIG_PATTERN.test(filePath) ||
    HIDDEN_DEVELOPMENT_ARTIFACT_FILE_PATTERN.test(filePath) ||
    DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_PATH_SUFFIXES.some(
      (artifactPath) => filePath === artifactPath || filePath.endsWith(artifactPath),
    ) ||
    DEPENDENCY_SCOPED_DEVELOPMENT_ARTIFACT_DIRECTORY_SEGMENTS.some(
      (directorySegment) =>
        filePath.endsWith(directorySegment.slice(0, -1)) || filePath.includes(directorySegment),
    )
  );
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findArchivePaths(directoryPath, readdirFn) {
  const entries = await readdirFn(directoryPath, { withFileTypes: true });
  const archives = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      archives.push(...(await findArchivePaths(entryPath, readdirFn)));
      continue;
    }

    if (entry.isFile() && entry.name === 'app.asar') {
      archives.push(entryPath);
    }
  }

  return archives;
}

export async function findDefaultArchivePaths({
  pathExistsFn = pathExists,
  readdirFn = readdir,
  releaseDir = RELEASE_DIR,
} = {}) {
  if (!(await pathExistsFn(releaseDir))) {
    throw new Error(`Release directory does not exist: ${releaseDir}`);
  }

  const archives = await findArchivePaths(releaseDir, readdirFn);

  if (archives.length === 0) {
    throw new Error(`No app.asar found under ${releaseDir}`);
  }

  return archives.sort();
}

export async function getArchivePaths(argv, options = {}) {
  const explicitPath = argv[2];
  if (explicitPath) {
    return [path.resolve(options.cwd ?? process.cwd(), explicitPath)];
  }

  return findDefaultArchivePaths(options);
}

export function verifyElectronArchiveMetadata(files, packageJson) {
  const failures = [];

  if (packageJson.main !== EXPECTED_ELECTRON_PACKAGE_MAIN) {
    failures.push(
      `package.json main expected ${EXPECTED_ELECTRON_PACKAGE_MAIN}, got ${packageJson.main}`,
    );
  }

  for (const requiredFile of REQUIRED_ELECTRON_PACKAGE_FILES) {
    if (!files.has(requiredFile)) {
      failures.push(`missing required file: ${requiredFile}`);
    }
  }

  const missingRuntimePackageFiles = getRequiredDirectRuntimePackageFiles(packageJson).filter(
    (requiredFile) => !files.has(requiredFile),
  );
  if (missingRuntimePackageFiles.length > 0) {
    failures.push(
      `missing packaged runtime dependencies (${missingRuntimePackageFiles.length}):\n${missingRuntimePackageFiles.join('\n')}`,
    );
  }

  for (const forbiddenFile of FORBIDDEN_ELECTRON_PACKAGE_FILES) {
    if (files.has(forbiddenFile)) {
      failures.push(`found forbidden stale file: ${forbiddenFile}`);
    }
  }

  const developmentArtifacts = [...files].filter(isDevelopmentArtifactPath).sort();
  if (developmentArtifacts.length > 0) {
    failures.push(
      `found packaged development artifacts (${developmentArtifacts.length}):\n${developmentArtifacts.join('\n')}`,
    );
  }

  const packagedRendererDependencies = [...files]
    .filter((filePath) =>
      RENDERER_BUNDLED_DEPENDENCY_SEGMENTS.some(
        (dependencySegment) =>
          filePath.endsWith(dependencySegment.slice(0, -1)) || filePath.includes(dependencySegment),
      ),
    )
    .sort();
  if (packagedRendererDependencies.length > 0) {
    failures.push(
      `found renderer-bundled dependencies in the Electron Node runtime (${packagedRendererDependencies.length}):\n${packagedRendererDependencies.join('\n')}`,
    );
  }

  return failures;
}

export function getPackagedElectronRuntimePackages(files, extractFile) {
  const runtimePackages = [];
  for (const filePath of files) {
    if (!filePath.includes('/node_modules/') || !filePath.endsWith('/package.json')) {
      continue;
    }

    const packageJson = JSON.parse(extractFile(filePath.slice(1)).toString('utf8'));
    if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
      runtimePackages.push({ name: packageJson.name, version: packageJson.version });
    }
  }

  return [
    ...new Map(
      runtimePackages.map((runtimePackage) => [
        getRuntimePackageIdentity(runtimePackage),
        runtimePackage,
      ]),
    ).values(),
  ].sort((left, right) =>
    getRuntimePackageIdentity(left).localeCompare(getRuntimePackageIdentity(right)),
  );
}

export function verifyElectronRuntimePackages(
  packagedRuntimePackages,
  requiredRuntimePackages = REQUIRED_ELECTRON_RUNTIME_PACKAGES,
) {
  const packagedIdentities = new Set(packagedRuntimePackages.map(getRuntimePackageIdentity));
  const missingIdentities = requiredRuntimePackages
    .map(getRuntimePackageIdentity)
    .filter((identity) => !packagedIdentities.has(identity))
    .sort();

  return missingIdentities.length === 0
    ? []
    : [
        `missing packaged runtime package identities (${missingIdentities.length}):\n${missingIdentities.join('\n')}`,
      ];
}

export function verifyArchive(
  archivePath,
  {
    extractFile = asar.extractFile,
    listPackage = asar.listPackage,
    requiredRuntimePackages = REQUIRED_ELECTRON_RUNTIME_PACKAGES,
  } = {},
) {
  const files = new Set(listPackage(archivePath));
  const packageJson = JSON.parse(extractFile(archivePath, 'package.json').toString('utf8'));
  const extractArchiveFile = (filePath) => extractFile(archivePath, filePath);
  const packagedRuntimePackages = getPackagedElectronRuntimePackages(files, extractArchiveFile);
  return [
    ...verifyElectronArchiveMetadata(files, packageJson),
    ...verifyElectronRuntimePackages(packagedRuntimePackages, requiredRuntimePackages),
  ];
}

export async function verifyFreshness(
  archivePath,
  {
    pathExistsFn = pathExists,
    projectRoot = PROJECT_ROOT,
    readdirFn = readdir,
    statFn = stat,
  } = {},
) {
  const archiveStats = await statFn(archivePath);
  const failures = [];

  for (const relativeInputPath of ELECTRON_PACKAGE_FRESHNESS_FILES) {
    const inputPath = path.join(projectRoot, relativeInputPath);
    if (!(await pathExistsFn(inputPath))) {
      failures.push(`freshness input is missing: ${relativeInputPath}`);
      continue;
    }

    const inputStats = await statFn(inputPath);
    if (archiveStats.mtimeMs + FRESHNESS_TOLERANCE_MS < inputStats.mtimeMs) {
      failures.push(`archive is older than freshness input: ${relativeInputPath}`);
    }
  }

  async function findNewestInputFile(directoryPath) {
    const entries = await readdirFn(directoryPath, { withFileTypes: true });
    let newest = null;

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        const nestedNewest = await findNewestInputFile(entryPath);
        if (nestedNewest && (!newest || nestedNewest.mtimeMs > newest.mtimeMs)) {
          newest = nestedNewest;
        }
        continue;
      }

      const entryStats = await statFn(entryPath);
      if (!newest || entryStats.mtimeMs > newest.mtimeMs) {
        newest = { filePath: entryPath, mtimeMs: entryStats.mtimeMs };
      }
    }

    return newest;
  }

  for (const relativeDirectoryPath of ELECTRON_PACKAGE_FRESHNESS_DIRECTORIES) {
    const directoryPath = path.join(projectRoot, relativeDirectoryPath);
    if (!(await pathExistsFn(directoryPath))) {
      failures.push(`freshness input is missing: ${relativeDirectoryPath}`);
      continue;
    }

    const newestInput = await findNewestInputFile(directoryPath);
    if (!newestInput) {
      failures.push(`freshness input directory is empty: ${relativeDirectoryPath}`);
      continue;
    }

    if (archiveStats.mtimeMs + FRESHNESS_TOLERANCE_MS < newestInput.mtimeMs) {
      const relativeInputPath = path
        .relative(projectRoot, newestInput.filePath)
        .split(path.sep)
        .join('/');
      failures.push(`archive is older than freshness input: ${relativeInputPath}`);
    }
  }

  return failures;
}

export async function verifyElectronPackage(archivePath, options = {}) {
  return [...verifyArchive(archivePath, options), ...(await verifyFreshness(archivePath, options))];
}

export async function runElectronPackageVerifier(argv = process.argv, options = {}) {
  const archivePaths = await getArchivePaths(argv, options);
  const verifyElectronPackageFn = options.verifyElectronPackageFn ?? verifyElectronPackage;
  const archiveResults = [];

  for (const archivePath of archivePaths) {
    let failures;
    try {
      failures = await verifyElectronPackageFn(archivePath, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures = [`verification error: ${message}`];
    }
    archiveResults.push({
      archivePath,
      failures,
    });
  }

  return { archiveResults };
}

async function main() {
  const { archiveResults } = await runElectronPackageVerifier();
  const failedResults = archiveResults.filter((result) => result.failures.length > 0);
  if (failedResults.length > 0) {
    console.error(
      `Electron package verification failed for ${failedResults.length} of ${archiveResults.length} archives.`,
    );
    for (const result of failedResults) {
      console.error(result.archivePath);
      for (const failure of result.failures) {
        console.error(`- ${failure}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  for (const result of archiveResults) {
    console.log(`Electron package verified: ${result.archivePath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
