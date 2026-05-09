#!/usr/bin/env node

import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
export const EXPECTED_ELECTRON_PACKAGE_MAIN = 'dist-electron/electron/main.js';
export const REQUIRED_ELECTRON_PACKAGE_FILES = [
  '/package.json',
  `/${EXPECTED_ELECTRON_PACKAGE_MAIN}`,
  '/electron/preload.cjs',
  '/dist/index.html',
  '/dist-remote/index.html',
];
export const FORBIDDEN_ELECTRON_PACKAGE_FILES = ['/dist-electron/main.js'];
const TEST_ARTIFACT_PATTERN = /\.(?:spec|test)\.(?:cjs|js|jsx|mjs|ts|tsx)$/u;
export const ELECTRON_PACKAGE_FRESHNESS_INPUTS = [
  'package.json',
  EXPECTED_ELECTRON_PACKAGE_MAIN,
  'electron/preload.cjs',
  'dist/index.html',
  'dist-remote/index.html',
];
const FRESHNESS_TOLERANCE_MS = 1_000;

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

export async function findDefaultArchivePath({
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

  if (archives.length > 1) {
    throw new Error(
      `Multiple app.asar archives found; pass one explicitly:\n${archives.join('\n')}`,
    );
  }

  return archives[0];
}

export async function getArchivePath(argv, options = {}) {
  const explicitPath = argv[2];
  if (explicitPath) {
    return path.resolve(options.cwd ?? process.cwd(), explicitPath);
  }

  return findDefaultArchivePath(options);
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

  for (const forbiddenFile of FORBIDDEN_ELECTRON_PACKAGE_FILES) {
    if (files.has(forbiddenFile)) {
      failures.push(`found forbidden stale file: ${forbiddenFile}`);
    }
  }

  const testArtifacts = [...files].filter((file) => TEST_ARTIFACT_PATTERN.test(file)).sort();
  if (testArtifacts.length > 0) {
    failures.push(
      `found packaged test artifacts (${testArtifacts.length}):\n${testArtifacts.join('\n')}`,
    );
  }

  return failures;
}

export function verifyArchive(
  archivePath,
  { extractFile = asar.extractFile, listPackage = asar.listPackage } = {},
) {
  const files = new Set(listPackage(archivePath));
  const packageJson = JSON.parse(extractFile(archivePath, 'package.json').toString('utf8'));
  return verifyElectronArchiveMetadata(files, packageJson);
}

export async function verifyFreshness(
  archivePath,
  { pathExistsFn = pathExists, projectRoot = PROJECT_ROOT, statFn = stat } = {},
) {
  const archiveStats = await statFn(archivePath);
  const failures = [];

  for (const relativeInputPath of ELECTRON_PACKAGE_FRESHNESS_INPUTS) {
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

  return failures;
}

export async function verifyElectronPackage(archivePath, options = {}) {
  return [...verifyArchive(archivePath, options), ...(await verifyFreshness(archivePath, options))];
}

export async function runElectronPackageVerifier(argv = process.argv, options = {}) {
  const archivePath = await getArchivePath(argv, options);
  const failures = await verifyElectronPackage(archivePath, options);
  return { archivePath, failures };
}

async function main() {
  const { archivePath, failures } = await runElectronPackageVerifier();
  if (failures.length > 0) {
    console.error(`Electron package verification failed for ${archivePath}`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Electron package verified: ${archivePath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
