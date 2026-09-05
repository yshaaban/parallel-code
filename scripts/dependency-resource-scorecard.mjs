#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { getCommandBin, runCommand as spawnCommand } from './lib/run-command.mjs';
import { isReleasePackageArtifactName } from './lib/release-artifact-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const SCORECARD_SCHEMA_VERSION = 1;
export const DEFAULT_SAMPLE_COUNT = 3;
export const FRESHNESS_TOLERANCE_MS = 1_000;
export const MAIN_ENTRY_GZIP_BUDGET_BYTES = 250 * 1024;
export const METADATA_COMMAND_TIMEOUT_MS = 10_000;
export const METADATA_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const SCORECARD_LIMITS = Object.freeze({
  archiveGrowthRatio: 0.03,
  fullReleaseBuildGrowthRatio: 0.1,
  installGrowthRatio: 0.15,
  rendererEntryGrowthRatio: 0.02,
});

const CAPTURE_STEPS = Object.freeze([
  Object.freeze({ key: 'install', command: 'npm', args: Object.freeze(['ci']) }),
  Object.freeze({
    key: 'frontendBuild',
    command: 'npm',
    args: Object.freeze(['run', 'build:frontend']),
  }),
  Object.freeze({
    key: 'remoteBuild',
    command: 'npm',
    args: Object.freeze(['run', 'build:remote']),
  }),
  Object.freeze({
    key: 'serverBuild',
    command: 'npm',
    args: Object.freeze(['run', 'build:server']),
  }),
  Object.freeze({
    key: 'fullReleaseBuild',
    command: 'npm',
    args: Object.freeze(['run', 'build', '--', '--publish', 'never']),
  }),
]);

const TIMING_KEYS = CAPTURE_STEPS.map(({ key }) => key);
const ENTRY_NAMES = Object.freeze(['main', 'remote']);
const ENTRY_SIZE_NAMES = Object.freeze(['raw', 'gzip', 'brotli']);
function assertPlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function assertRelativeArtifactPath(filePath, label) {
  assertNonEmptyString(filePath, label);
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the project root.`);
  }
  return normalized;
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

export function getCaptureProtocol() {
  return {
    id: 'dependency-resource-scorecard-v1',
    state: 'clean install before each sample; owner builds followed by a full release build',
    steps: CAPTURE_STEPS.map(({ key, command, args }) => ({ key, command, args: [...args] })),
  };
}

function getMedian(values) {
  if (values.length === 0) throw new Error('Cannot aggregate an empty sample set.');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function aggregateValues(values, label) {
  for (const [index, value] of values.entries()) {
    assertNonNegativeNumber(value, `${label} sample ${index + 1}`);
  }
  return Object.freeze({
    median: getMedian(values),
    worst: Math.max(...values),
  });
}

async function collectDirectoryStats(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  let bytes = 0;
  let fileCount = 0;
  let newestMtimeMs = 0;

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const child = await collectDirectoryStats(entryPath);
      bytes += child.bytes;
      fileCount += child.fileCount;
      newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
    } else if (entry.isFile()) {
      const metadata = await stat(entryPath);
      bytes += metadata.size;
      fileCount += 1;
      newestMtimeMs = Math.max(newestMtimeMs, metadata.mtimeMs);
    }
  }

  return { bytes, fileCount, newestMtimeMs };
}

export async function getDirectorySizeBytes(directoryPath) {
  let stats;
  try {
    stats = await collectDirectoryStats(directoryPath);
  } catch (error) {
    throw new Error(
      `Cannot measure directory ${directoryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stats.fileCount === 0) throw new Error(`Measured directory is empty: ${directoryPath}`);
  return stats.bytes;
}

async function getFileRecord(projectRoot, filePath, freshAfterMs, label) {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new Error(`${label} is missing: ${toPosixPath(path.relative(projectRoot, filePath))}`);
  }
  if (!metadata.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (metadata.size <= 0) throw new Error(`${label} is empty: ${filePath}`);
  if (metadata.mtimeMs + FRESHNESS_TOLERANCE_MS < freshAfterMs) {
    throw new Error(
      `${label} is stale: ${toPosixPath(path.relative(projectRoot, filePath))} was not rebuilt by the full release command.`,
    );
  }
  return {
    bytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    path: assertRelativeArtifactPath(
      toPosixPath(path.relative(projectRoot, filePath)),
      `${label} path`,
    ),
  };
}

function getEntryScriptSource(indexHtml, label) {
  const sources = [];
  for (const match of indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/giu)) {
    const source = match[2];
    if (/\.m?js(?:[?#].*)?$/iu.test(source)) sources.push(source);
  }
  if (sources.length !== 1) {
    throw new Error(
      `${label} must reference exactly one eager script entry; found ${sources.length}.`,
    );
  }
  const source = sources[0];
  if (/^(?:[a-z]+:|\/|\\)/iu.test(source)) {
    throw new Error(`${label} eager entry must be a project-relative path: ${source}`);
  }
  return source.replace(/[?#].*$/u, '');
}

async function collectEntry(projectRoot, directoryName, freshAfterMs, label) {
  const directoryPath = path.join(projectRoot, directoryName);
  const htmlPath = path.join(directoryPath, 'index.html');
  const html = await getFileRecord(projectRoot, htmlPath, freshAfterMs, `${label} HTML`);
  const indexHtml = await readFile(htmlPath, 'utf8');
  const source = getEntryScriptSource(indexHtml, `${label} HTML`);
  const rawPath = path.resolve(directoryPath, source);
  const relativeToDirectory = path.relative(directoryPath, rawPath);
  if (
    relativeToDirectory === '..' ||
    relativeToDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToDirectory)
  ) {
    throw new Error(`${label} eager entry escapes ${directoryName}: ${source}`);
  }

  const [raw, gzip, brotli] = await Promise.all([
    getFileRecord(projectRoot, rawPath, freshAfterMs, `${label} eager entry`),
    getFileRecord(projectRoot, `${rawPath}.gz`, freshAfterMs, `${label} eager gzip entry`),
    getFileRecord(projectRoot, `${rawPath}.br`, freshAfterMs, `${label} eager Brotli entry`),
  ]);
  return { html, raw, gzip, brotli };
}

async function listFilesRecursively(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function isUnpackedReleaseDirectory(name) {
  return (
    /^(?:linux|win)(?:-[a-z0-9_]+)?-unpacked$/iu.test(name) || /^mac(?:-[a-z0-9_]+)?$/iu.test(name)
  );
}

async function collectReleaseArtifacts(projectRoot, freshAfterMs) {
  const releaseDir = path.join(projectRoot, 'release');
  let topLevelEntries;
  try {
    topLevelEntries = await readdir(releaseDir, { withFileTypes: true });
  } catch {
    throw new Error('Release directory is missing; run the full release build first.');
  }

  const artifacts = [];
  const allFiles = await listFilesRecursively(releaseDir);
  for (const filePath of allFiles) {
    if (path.basename(filePath) !== 'app.asar') continue;
    const record = await getFileRecord(projectRoot, filePath, freshAfterMs, 'Electron app.asar');
    artifacts.push({
      id: `app-asar:${record.path.slice('release/'.length)}`,
      kind: 'app-asar',
      ...record,
    });
  }

  for (const entry of topLevelEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(releaseDir, entry.name);
    if (entry.isDirectory() && isUnpackedReleaseDirectory(entry.name)) {
      const directoryStats = await collectDirectoryStats(entryPath);
      if (directoryStats.fileCount === 0) {
        throw new Error(`Electron unpacked artifact is empty: release/${entry.name}`);
      }
      if (directoryStats.newestMtimeMs + FRESHNESS_TOLERANCE_MS < freshAfterMs) {
        throw new Error(
          `Electron unpacked artifact is stale: release/${entry.name} was not rebuilt by the full release command.`,
        );
      }
      artifacts.push({
        bytes: directoryStats.bytes,
        id: `unpacked:${entry.name}`,
        kind: 'unpacked',
        mtimeMs: directoryStats.newestMtimeMs,
        path: `release/${entry.name}`,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isReleasePackageArtifactName(entry.name)) continue;
    const record = await getFileRecord(
      projectRoot,
      entryPath,
      freshAfterMs,
      'Electron package artifact',
    );
    artifacts.push({
      id: `package:${entry.name}`,
      kind: 'package',
      ...record,
    });
  }

  artifacts.sort((left, right) => left.id.localeCompare(right.id));
  if (!artifacts.some(({ kind }) => kind === 'app-asar')) {
    throw new Error('No fresh app.asar artifact was found under release/.');
  }
  if (!artifacts.some(({ kind }) => kind === 'unpacked')) {
    throw new Error('No fresh unpacked Electron artifact was found under release/.');
  }
  return artifacts;
}

export async function collectResourceSnapshot({ projectRoot = PROJECT_ROOT, freshAfterMs }) {
  assertNonNegativeNumber(freshAfterMs, 'Freshness cutoff');
  const [main, remote, artifacts] = await Promise.all([
    collectEntry(projectRoot, 'dist', freshAfterMs, 'Main renderer'),
    collectEntry(projectRoot, 'dist-remote', freshAfterMs, 'Remote renderer'),
    collectReleaseArtifacts(projectRoot, freshAfterMs),
  ]);
  return { entries: { main, remote }, artifacts };
}

function validateFileRecord(rawRecord, label, freshAfterMs, completedAtMs) {
  const record = assertPlainRecord(rawRecord, label);
  assertRelativeArtifactPath(record.path, `${label} path`);
  assertPositiveInteger(record.bytes, `${label} bytes`);
  assertNonNegativeNumber(record.mtimeMs, `${label} mtimeMs`);
  if (record.mtimeMs + FRESHNESS_TOLERANCE_MS < freshAfterMs) {
    throw new Error(`${label} is stale relative to its full release build.`);
  }
  if (record.mtimeMs > completedAtMs + FRESHNESS_TOLERANCE_MS) {
    throw new Error(`${label} has an impossible future modification time.`);
  }
}

function validateSample(rawSample, expectedIndex) {
  const sample = assertPlainRecord(rawSample, `Sample ${expectedIndex}`);
  if (sample.index !== expectedIndex) {
    throw new Error(`Sample index ${String(sample.index)} must be ${expectedIndex}.`);
  }
  const startedAtMs = Date.parse(
    assertNonEmptyString(sample.startedAt, `Sample ${expectedIndex} start`),
  );
  const completedAtMs = Date.parse(
    assertNonEmptyString(sample.completedAt, `Sample ${expectedIndex} completion`),
  );
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    throw new Error(`Sample ${expectedIndex} timestamps must be valid ISO dates.`);
  }
  if (completedAtMs < startedAtMs) {
    throw new Error(`Sample ${expectedIndex} completes before it starts.`);
  }
  assertNonNegativeNumber(
    sample.fullReleaseBuildStartedAtMs,
    `Sample ${expectedIndex} full release start`,
  );
  if (
    sample.fullReleaseBuildStartedAtMs < startedAtMs - FRESHNESS_TOLERANCE_MS ||
    sample.fullReleaseBuildStartedAtMs > completedAtMs + FRESHNESS_TOLERANCE_MS
  ) {
    throw new Error(`Sample ${expectedIndex} full release start is outside the sample window.`);
  }

  const timingsMs = assertPlainRecord(sample.timingsMs, `Sample ${expectedIndex} timings`);
  for (const key of TIMING_KEYS) {
    assertNonNegativeNumber(timingsMs[key], `Sample ${expectedIndex} ${key} timing`);
  }
  assertPositiveInteger(sample.nodeModulesBytes, `Sample ${expectedIndex} node_modules bytes`);

  const entries = assertPlainRecord(sample.entries, `Sample ${expectedIndex} entries`);
  for (const entryName of ENTRY_NAMES) {
    const entry = assertPlainRecord(
      entries[entryName],
      `Sample ${expectedIndex} ${entryName} entry`,
    );
    for (const fileName of ['html', ...ENTRY_SIZE_NAMES]) {
      validateFileRecord(
        entry[fileName],
        `Sample ${expectedIndex} ${entryName} ${fileName}`,
        sample.fullReleaseBuildStartedAtMs,
        completedAtMs,
      );
    }
  }

  if (!Array.isArray(sample.artifacts) || sample.artifacts.length === 0) {
    throw new Error(`Sample ${expectedIndex} must contain release artifacts.`);
  }
  const artifactIds = new Set();
  for (const [artifactIndex, rawArtifact] of sample.artifacts.entries()) {
    const label = `Sample ${expectedIndex} artifact ${artifactIndex + 1}`;
    const artifact = assertPlainRecord(rawArtifact, label);
    assertNonEmptyString(artifact.id, `${label} id`);
    if (artifactIds.has(artifact.id)) throw new Error(`${label} duplicates id ${artifact.id}.`);
    artifactIds.add(artifact.id);
    if (!['app-asar', 'package', 'unpacked'].includes(artifact.kind)) {
      throw new Error(`${label} has unknown kind ${String(artifact.kind)}.`);
    }
    validateFileRecord(artifact, label, sample.fullReleaseBuildStartedAtMs, completedAtMs);
  }
  if (!sample.artifacts.some(({ kind }) => kind === 'app-asar')) {
    throw new Error(`Sample ${expectedIndex} has no app.asar artifact.`);
  }
  if (!sample.artifacts.some(({ kind }) => kind === 'unpacked')) {
    throw new Error(`Sample ${expectedIndex} has no unpacked artifact.`);
  }
  return sample;
}

function assertStableSampleShape(samples) {
  const entryDirectories = { main: 'dist', remote: 'dist-remote' };
  const first = samples[0];
  const expectedArtifacts = first.artifacts.map(({ id, kind, path: artifactPath }) => ({
    id,
    kind,
    path: artifactPath,
  }));

  for (const sample of samples) {
    for (const entryName of ENTRY_NAMES) {
      const entry = sample.entries[entryName];
      const directory = entryDirectories[entryName];
      if (entry.html.path !== `${directory}/index.html`) {
        throw new Error(`${entryName} HTML path must identify ${directory}/index.html.`);
      }
      if (!entry.raw.path.startsWith(`${directory}/`) || !/\.m?js$/u.test(entry.raw.path)) {
        throw new Error(
          `${entryName} raw path must identify a JavaScript entry under ${directory}/.`,
        );
      }
      if (entry.gzip.path !== `${entry.raw.path}.gz`) {
        throw new Error(`${entryName} gzip path must match its raw entry path.`);
      }
      if (entry.brotli.path !== `${entry.raw.path}.br`) {
        throw new Error(`${entryName} Brotli path must match its raw entry path.`);
      }
    }
  }

  for (const sample of samples.slice(1)) {
    const artifacts = sample.artifacts.map(({ id, kind, path: artifactPath }) => ({
      id,
      kind,
      path: artifactPath,
    }));
    if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
      throw new Error(
        'Release artifact set changed between samples; the build is not reproducible.',
      );
    }
  }
}

export function summarizeSamples(rawSamples) {
  if (!Array.isArray(rawSamples) || rawSamples.length < DEFAULT_SAMPLE_COUNT) {
    throw new Error(`A scorecard requires at least ${DEFAULT_SAMPLE_COUNT} samples.`);
  }
  const samples = rawSamples.map((sample, index) => validateSample(sample, index + 1));
  assertStableSampleShape(samples);

  const timingsMs = Object.fromEntries(
    TIMING_KEYS.map((key) => [
      key,
      aggregateValues(
        samples.map((sample) => sample.timingsMs[key]),
        `${key} timing`,
      ),
    ]),
  );
  const entries = Object.fromEntries(
    ENTRY_NAMES.map((entryName) => [
      entryName,
      {
        ...Object.fromEntries(
          ENTRY_SIZE_NAMES.map((fileName) => [
            `${fileName}Bytes`,
            aggregateValues(
              samples.map((sample) => sample.entries[entryName][fileName].bytes),
              `${entryName} ${fileName} bytes`,
            ),
          ]),
        ),
      },
    ]),
  );
  const artifacts = samples[0].artifacts.map((artifact, artifactIndex) => ({
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    bytes: aggregateValues(
      samples.map((sample) => sample.artifacts[artifactIndex].bytes),
      `${artifact.id} bytes`,
    ),
  }));

  return {
    timingsMs,
    nodeModulesBytes: aggregateValues(
      samples.map((sample) => sample.nodeModulesBytes),
      'node_modules bytes',
    ),
    entries,
    artifacts,
  };
}

function assertEnvironment(environment, label) {
  const value = assertPlainRecord(environment, `${label} environment`);
  for (const field of [
    'arch',
    'cpuModel',
    'hostname',
    'nodeVersion',
    'npmVersion',
    'osRelease',
    'platform',
  ]) {
    assertNonEmptyString(value[field], `${label} environment ${field}`);
  }
  assertPositiveInteger(value.logicalCpuCount, `${label} environment logicalCpuCount`);
  assertPositiveInteger(value.totalMemoryBytes, `${label} environment totalMemoryBytes`);
  for (const field of ['lockfileSha256', 'packageJsonSha256']) {
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[field])) {
      throw new Error(`${label} environment ${field} must be a SHA-256 digest.`);
    }
  }
}

function assertProtocol(protocol, label) {
  const value = assertPlainRecord(protocol, `${label} protocol`);
  assertNonEmptyString(value.id, `${label} protocol id`);
  assertNonEmptyString(value.state, `${label} protocol state`);
  if (!Array.isArray(value.steps) || value.steps.length !== CAPTURE_STEPS.length) {
    throw new Error(`${label} protocol must contain ${CAPTURE_STEPS.length} steps.`);
  }
  if (JSON.stringify(value) !== JSON.stringify(getCaptureProtocol())) {
    throw new Error(`${label} uses an unknown capture protocol.`);
  }
}

export function validateScorecard(rawScorecard, label = 'Scorecard') {
  const scorecard = assertPlainRecord(rawScorecard, label);
  if (scorecard.schemaVersion !== SCORECARD_SCHEMA_VERSION) {
    throw new Error(
      `${label} schema version must be ${SCORECARD_SCHEMA_VERSION}, received ${String(scorecard.schemaVersion)}.`,
    );
  }
  if (scorecard.kind !== 'dependency-resource-scorecard') {
    throw new Error(`${label} has unknown kind ${String(scorecard.kind)}.`);
  }
  assertNonEmptyString(scorecard.label, `${label} label`);
  const capturedAtMs = Date.parse(
    assertNonEmptyString(scorecard.capturedAt, `${label} capturedAt`),
  );
  if (!Number.isFinite(capturedAtMs)) throw new Error(`${label} capturedAt must be an ISO date.`);
  assertEnvironment(scorecard.environment, label);
  assertProtocol(scorecard.protocol, label);
  if (!Array.isArray(scorecard.samples) || scorecard.samples.length < DEFAULT_SAMPLE_COUNT) {
    throw new Error(`${label} requires at least ${DEFAULT_SAMPLE_COUNT} samples.`);
  }
  if (scorecard.sampleCount !== scorecard.samples.length) {
    throw new Error(`${label} sampleCount does not match samples[].`);
  }
  const summary = summarizeSamples(scorecard.samples);
  if (JSON.stringify(scorecard.summary) !== JSON.stringify(summary)) {
    throw new Error(`${label} summary does not match its samples.`);
  }
  const finalCompletionMs = Date.parse(scorecard.samples.at(-1).completedAt);
  if (capturedAtMs + FRESHNESS_TOLERANCE_MS < finalCompletionMs) {
    throw new Error(`${label} capturedAt predates its final sample.`);
  }
  return scorecard;
}

export function runMetadataCommand(
  command,
  args,
  {
    clearTimeoutFn = clearTimeout,
    cwd,
    outputLimitBytes = METADATA_OUTPUT_LIMIT_BYTES,
    setTimeoutFn = setTimeout,
    spawnFn = spawn,
    timeoutMs = METADATA_COMMAND_TIMEOUT_MS,
  },
) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(getCommandBin(command), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const timeout = setTimeoutFn(() => {
      fail(new Error(`${command} ${args.join(' ')} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);

    function settle(action, value) {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timeout);
      action(value);
    }

    function fail(error) {
      if (settled) return;
      child.kill('SIGKILL');
      settle(reject, error);
    }

    function appendOutput(streamName, current, chunk) {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (current.byteLength + nextChunk.byteLength > outputLimitBytes) {
        fail(
          new Error(
            `${command} ${args.join(' ')} ${streamName} exceeded ${outputLimitBytes} bytes.`,
          ),
        );
        return current;
      }
      return Buffer.concat([current, nextChunk], current.byteLength + nextChunk.byteLength);
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput('stdout', stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput('stderr', stderr, chunk);
    });
    child.once('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (signal || code !== 0) {
        const diagnostic = stderr.toString('utf8').trim();
        settle(
          reject,
          new Error(
            `${command} ${args.join(' ')} failed${signal ? ` with ${signal}` : ` with exit ${String(code)}`}${diagnostic ? `: ${diagnostic}` : '.'}`,
          ),
        );
        return;
      }
      settle(resolve, stdout.toString('utf8').trim());
    });
  });
}

export async function getProjectInputDigests(projectRoot = PROJECT_ROOT) {
  const [lockBytes, packageJsonBytes] = await Promise.all([
    readFile(path.join(projectRoot, 'package-lock.json')),
    readFile(path.join(projectRoot, 'package.json')),
  ]);
  return {
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    packageJsonSha256: createHash('sha256').update(packageJsonBytes).digest('hex'),
  };
}

async function getCaptureEnvironment(projectRoot) {
  const [npmVersion, inputDigests] = await Promise.all([
    runMetadataCommand('npm', ['--version'], { cwd: projectRoot }),
    getProjectInputDigests(projectRoot),
  ]);
  const cpus = os.cpus();
  return {
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    hostname: os.hostname(),
    lockfileSha256: inputDigests.lockfileSha256,
    logicalCpuCount: cpus.length,
    nodeVersion: process.version,
    npmVersion,
    osRelease: os.release(),
    packageJsonSha256: inputDigests.packageJsonSha256,
    platform: process.platform,
    totalMemoryBytes: os.totalmem(),
  };
}

async function runMeasuredStep(step, { monotonicNow, projectRoot, runCommand }) {
  const startedAt = monotonicNow();
  const result = await runCommand(step.command, [...step.args], { cwd: projectRoot });
  const durationMs = roundMilliseconds(monotonicNow() - startedAt);
  if (result.signal) throw new Error(`${step.key} terminated with signal ${result.signal}.`);
  if (result.code !== 0) throw new Error(`${step.key} failed with exit ${result.code}.`);
  return durationMs;
}

export async function captureScorecard(
  { label, samples = DEFAULT_SAMPLE_COUNT },
  {
    collectResourceSnapshotFn = collectResourceSnapshot,
    epochNow = Date.now,
    getDirectorySizeBytesFn = getDirectorySizeBytes,
    getEnvironmentFn = getCaptureEnvironment,
    monotonicNow = () => globalThis.performance.now(),
    onProgress = () => {},
    projectRoot = PROJECT_ROOT,
    runCommand = spawnCommand,
  } = {},
) {
  assertNonEmptyString(label, 'Scorecard label');
  if (!Number.isInteger(samples) || samples < DEFAULT_SAMPLE_COUNT) {
    throw new Error(`Scorecard samples must be an integer of at least ${DEFAULT_SAMPLE_COUNT}.`);
  }
  const environment = await getEnvironmentFn(projectRoot);
  assertEnvironment(environment, 'Capture');
  const capturedSamples = [];

  for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
    onProgress(`Starting dependency resource sample ${sampleIndex}/${samples}`);
    const startedAtMs = epochNow();
    const timingsMs = {};
    let nodeModulesBytes;
    let fullReleaseBuildStartedAtMs;

    for (const step of CAPTURE_STEPS) {
      if (step.key === 'fullReleaseBuild') fullReleaseBuildStartedAtMs = epochNow();
      timingsMs[step.key] = await runMeasuredStep(step, {
        monotonicNow,
        projectRoot,
        runCommand,
      });
      if (step.key === 'install') {
        nodeModulesBytes = await getDirectorySizeBytesFn(path.join(projectRoot, 'node_modules'));
      }
    }

    const resources = await collectResourceSnapshotFn({
      freshAfterMs: fullReleaseBuildStartedAtMs,
      projectRoot,
    });
    const completedAtMs = epochNow();
    capturedSamples.push({
      index: sampleIndex,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      fullReleaseBuildStartedAtMs,
      timingsMs,
      nodeModulesBytes,
      ...resources,
    });
  }

  const capturedAt = new Date(epochNow()).toISOString();
  const scorecard = {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    kind: 'dependency-resource-scorecard',
    label,
    capturedAt,
    environment,
    protocol: getCaptureProtocol(),
    sampleCount: capturedSamples.length,
    samples: capturedSamples,
    summary: summarizeSamples(capturedSamples),
  };
  return validateScorecard(scorecard, 'Captured scorecard');
}

function assertCompatibleScorecards(baseline, target) {
  if (baseline.sampleCount !== target.sampleCount) {
    throw new Error('Baseline and target must use the same sample count.');
  }
  if (JSON.stringify(baseline.protocol) !== JSON.stringify(target.protocol)) {
    throw new Error('Baseline and target use different capture protocols.');
  }
  const comparableEnvironmentFields = [
    'arch',
    'cpuModel',
    'hostname',
    'logicalCpuCount',
    'nodeVersion',
    'npmVersion',
    'osRelease',
    'platform',
    'totalMemoryBytes',
  ];
  for (const field of comparableEnvironmentFields) {
    if (baseline.environment[field] !== target.environment[field]) {
      throw new Error(
        `Baseline and target environment mismatch for ${field}: ${String(baseline.environment[field])} != ${String(target.environment[field])}.`,
      );
    }
  }

  const baselineArtifacts = baseline.summary.artifacts.map(({ id, kind, path: artifactPath }) => ({
    id,
    kind,
    path: artifactPath,
  }));
  const targetArtifacts = target.summary.artifacts.map(({ id, kind, path: artifactPath }) => ({
    id,
    kind,
    path: artifactPath,
  }));
  if (JSON.stringify(baselineArtifacts) !== JSON.stringify(targetArtifacts)) {
    throw new Error('Baseline and target release artifact sets do not match.');
  }
}

function createGrowthCheck(id, label, baseline, target, limitRatio, { gateWorst = false } = {}) {
  assertPositiveNumber(baseline.median, `${label} baseline median`);
  assertPositiveNumber(baseline.worst, `${label} baseline worst`);
  assertNonNegativeNumber(target.median, `${label} target median`);
  assertNonNegativeNumber(target.worst, `${label} target worst`);
  const growthRatios = {
    median: target.median / baseline.median - 1,
    worst: target.worst / baseline.worst - 1,
  };
  const tolerance = Number.EPSILON * 16;
  return {
    id,
    label,
    baseline,
    target,
    growthRatios,
    gateWorst,
    limitRatio,
    passed:
      growthRatios.median <= limitRatio + tolerance &&
      (!gateWorst || growthRatios.worst <= limitRatio + tolerance),
  };
}

function createAbsoluteCheck(id, label, target, limitBytes) {
  assertNonNegativeNumber(target.median, `${label} target median`);
  assertNonNegativeNumber(target.worst, `${label} target worst`);
  return {
    id,
    label,
    target,
    limitBytes,
    passed: target.median < limitBytes && target.worst < limitBytes,
  };
}

export function compareScorecards(rawBaseline, rawTarget) {
  const baseline = validateScorecard(rawBaseline, 'Baseline scorecard');
  const target = validateScorecard(rawTarget, 'Target scorecard');
  assertCompatibleScorecards(baseline, target);
  const checks = [
    createGrowthCheck(
      'install-duration',
      'npm ci median duration',
      baseline.summary.timingsMs.install,
      target.summary.timingsMs.install,
      SCORECARD_LIMITS.installGrowthRatio,
    ),
    createGrowthCheck(
      'full-release-build-duration',
      'full release build median duration',
      baseline.summary.timingsMs.fullReleaseBuild,
      target.summary.timingsMs.fullReleaseBuild,
      SCORECARD_LIMITS.fullReleaseBuildGrowthRatio,
    ),
  ];

  for (const entryName of ENTRY_NAMES) {
    for (const sizeName of ENTRY_SIZE_NAMES) {
      checks.push(
        createGrowthCheck(
          `${entryName}-${sizeName}-bytes`,
          `${entryName} eager entry ${sizeName} bytes`,
          baseline.summary.entries[entryName][`${sizeName}Bytes`],
          target.summary.entries[entryName][`${sizeName}Bytes`],
          SCORECARD_LIMITS.rendererEntryGrowthRatio,
          { gateWorst: true },
        ),
      );
    }
  }
  for (const [index, artifact] of baseline.summary.artifacts.entries()) {
    checks.push(
      createGrowthCheck(
        `artifact:${artifact.id}`,
        `${artifact.kind} ${artifact.path}`,
        artifact.bytes,
        target.summary.artifacts[index].bytes,
        SCORECARD_LIMITS.archiveGrowthRatio,
        { gateWorst: true },
      ),
    );
  }
  checks.push(
    createAbsoluteCheck(
      'main-gzip-budget',
      'main eager entry gzip bytes',
      target.summary.entries.main.gzipBytes,
      MAIN_ENTRY_GZIP_BUDGET_BYTES,
    ),
  );

  return {
    passed: checks.every(({ passed }) => passed),
    baselineLabel: baseline.label,
    targetLabel: target.label,
    checks,
    reported: {
      frontendBuildDurationMs: {
        baseline: baseline.summary.timingsMs.frontendBuild,
        target: target.summary.timingsMs.frontendBuild,
      },
      nodeModulesBytes: {
        baseline: baseline.summary.nodeModulesBytes,
        target: target.summary.nodeModulesBytes,
      },
      remoteBuildDurationMs: {
        baseline: baseline.summary.timingsMs.remoteBuild,
        target: target.summary.timingsMs.remoteBuild,
      },
      serverBuildDurationMs: {
        baseline: baseline.summary.timingsMs.serverBuild,
        target: target.summary.timingsMs.serverBuild,
      },
    },
  };
}

/**
 * Release evidence may compare against a historical baseline, but its target must describe the
 * package inputs currently under review. Keep this freshness decision beside scorecard capture and
 * comparison so callers cannot accidentally treat a stale green target as current evidence.
 */
export function assertTargetMatchesCurrentProjectInputs(target, currentInputDigests) {
  const targetScorecard = validateScorecard(target, 'Target scorecard');
  const current = assertPlainRecord(currentInputDigests, 'Current project input digests');
  for (const [field, fileName] of [
    ['packageJsonSha256', 'package.json'],
    ['lockfileSha256', 'package-lock.json'],
  ]) {
    if (typeof current[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(current[field])) {
      throw new Error(`Current project ${fileName} digest must be a SHA-256 digest.`);
    }
    if (targetScorecard.environment[field] !== current[field]) {
      throw new Error(
        `Target scorecard is stale for current ${fileName}: captured ${targetScorecard.environment[field]}, current ${current[field]}. Recapture the target scorecard after package metadata is frozen.`,
      );
    }
  }
}

function formatBytes(value) {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} B`;
}

function formatMilliseconds(value) {
  return `${value.toFixed(1)} ms`;
}

function formatAggregate(aggregate, formatter) {
  return `median=${formatter(aggregate.median)}, worst=${formatter(aggregate.worst)}`;
}

export function formatComparisonReport(report) {
  const lines = [`Dependency resource scorecard: ${report.baselineLabel} -> ${report.targetLabel}`];
  for (const check of report.checks) {
    if ('growthRatios' in check) {
      const growth = check.gateWorst
        ? `median ${(check.growthRatios.median * 100).toFixed(2)}%, worst ${(check.growthRatios.worst * 100).toFixed(2)}%`
        : `median ${(check.growthRatios.median * 100).toFixed(2)}%`;
      lines.push(
        `${check.passed ? 'PASS' : 'FAIL'} ${check.label}: ${growth} growth (limit ${(check.limitRatio * 100).toFixed(0)}%); baseline ${formatAggregate(check.baseline, check.id.includes('duration') ? formatMilliseconds : formatBytes)}; target ${formatAggregate(check.target, check.id.includes('duration') ? formatMilliseconds : formatBytes)}`,
      );
    } else {
      lines.push(
        `${check.passed ? 'PASS' : 'FAIL'} ${check.label}: ${formatAggregate(check.target, formatBytes)} (budget < ${formatBytes(check.limitBytes)})`,
      );
    }
  }
  lines.push(
    `REPORT node_modules: baseline ${formatAggregate(report.reported.nodeModulesBytes.baseline, formatBytes)}; target ${formatAggregate(report.reported.nodeModulesBytes.target, formatBytes)}`,
  );
  for (const [label, metric] of [
    ['frontend build', report.reported.frontendBuildDurationMs],
    ['remote build', report.reported.remoteBuildDurationMs],
    ['server build', report.reported.serverBuildDurationMs],
  ]) {
    lines.push(
      `REPORT ${label}: baseline ${formatAggregate(metric.baseline, formatMilliseconds)}; target ${formatAggregate(metric.target, formatMilliseconds)}`,
    );
  }
  lines.push(report.passed ? 'Scorecard passed.' : 'Scorecard failed.');
  return lines.join('\n');
}

function parsePositiveSampleCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < DEFAULT_SAMPLE_COUNT) {
    throw new Error(`--samples must be an integer of at least ${DEFAULT_SAMPLE_COUNT}.`);
  }
  return parsed;
}

function parseNamedOptions(args, allowedNames) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowedNames.has(argument)) throw new Error(`Unknown scorecard option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    if (Object.hasOwn(values, argument)) throw new Error(`${argument} may be supplied only once.`);
    values[argument] = value;
    index += 1;
  }
  return values;
}

export function parseScorecardArguments(argv) {
  const [command, ...args] = argv;
  if (command === 'capture') {
    const values = parseNamedOptions(args, new Set(['--label', '--output', '--samples']));
    return {
      command,
      label: assertNonEmptyString(values['--label'], '--label'),
      output: assertNonEmptyString(values['--output'], '--output'),
      samples:
        values['--samples'] === undefined
          ? DEFAULT_SAMPLE_COUNT
          : parsePositiveSampleCount(values['--samples']),
    };
  }
  if (command === 'compare') {
    const values = parseNamedOptions(args, new Set(['--baseline', '--target']));
    return {
      command,
      baseline: assertNonEmptyString(values['--baseline'], '--baseline'),
      target: assertNonEmptyString(values['--target'], '--target'),
    };
  }
  throw new Error('Usage: dependency-resource-scorecard.mjs <capture|compare> [options]');
}

function resolveCaptureOutputPath(projectRoot, output) {
  const outputPath = path.resolve(projectRoot, output);
  const allowedRoots = ['tmp', 'artifacts'].map((directory) => path.join(projectRoot, directory));
  if (
    !allowedRoots.some((root) => {
      const relative = path.relative(root, outputPath);
      return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })
  ) {
    throw new Error('Scorecard output must be a file under tmp/ or artifacts/.');
  }
  if (path.extname(outputPath).toLowerCase() !== '.json') {
    throw new Error('Scorecard output must use a .json extension.');
  }
  return outputPath;
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readScorecardFile(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read ${label} scorecard ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateScorecard(parsed, `${label} scorecard`);
}

export async function runScorecardCli(
  argv,
  { getProjectInputDigestsFn = getProjectInputDigests, projectRoot = PROJECT_ROOT } = {},
) {
  const options = parseScorecardArguments(argv);
  if (options.command === 'capture') {
    const outputPath = resolveCaptureOutputPath(projectRoot, options.output);
    const scorecard = await captureScorecard(
      { label: options.label, samples: options.samples },
      {
        projectRoot,
        onProgress: (message) => process.stdout.write(`${message}\n`),
      },
    );
    await writeJsonAtomically(outputPath, scorecard);
    return {
      exitCode: 0,
      output: `Wrote dependency resource scorecard to ${toPosixPath(path.relative(projectRoot, outputPath))}`,
    };
  }

  const [baseline, target, currentInputDigests] = await Promise.all([
    readScorecardFile(path.resolve(projectRoot, options.baseline), 'baseline'),
    readScorecardFile(path.resolve(projectRoot, options.target), 'target'),
    getProjectInputDigestsFn(projectRoot),
  ]);
  assertTargetMatchesCurrentProjectInputs(target, currentInputDigests);
  const report = compareScorecards(baseline, target);
  return {
    exitCode: report.passed ? 0 : 1,
    output: formatComparisonReport(report),
  };
}

async function main() {
  try {
    const result = await runScorecardCli(process.argv.slice(2));
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `Dependency resource scorecard failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) await main();
