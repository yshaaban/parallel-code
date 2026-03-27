#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import buildArtifactConfig from '../server/build-artifacts-config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SERVER_ENTRY_PATH = path.join(PROJECT_ROOT, 'dist-server', 'server', 'main.js');
const DEFAULT_PLAYWRIGHT_ARGS = ['playwright', 'test'];
const SKIP_BROWSER_BUILD_ARTIFACT_CHECK_ENV = 'PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK';

const ignoredSourceDirs = new Set(buildArtifactConfig.ignoredSourceDirs);
const ignoredSourceFilePatterns = buildArtifactConfig.ignoredSourceFilePatterns.map(
  (pattern) => new RegExp(pattern, 'u'),
);

function getCommandBin(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

export function shouldCheckBrowserBuildArtifacts(env = process.env) {
  return env[SKIP_BROWSER_BUILD_ARTIFACT_CHECK_ENV] !== '1';
}

async function runPlaywrightCommand(runCommand, args) {
  const playwrightResult = await runCommand('npx', [...DEFAULT_PLAYWRIGHT_ARGS, ...args]);
  return playwrightResult.code ?? 1;
}

function getServerEntryPath(projectRoot) {
  return path.join(projectRoot, 'dist-server', 'server', 'main.js');
}

function shouldIgnoreBuildSourceEntry(name) {
  return ignoredSourceDirs.has(name);
}

function shouldIgnoreBuildSourceFile(filePath) {
  return ignoredSourceFilePatterns.some((pattern) => pattern.test(filePath));
}

async function getLatestSourceFileEntry(sourcePath) {
  const stats = await stat(sourcePath).catch(() => null);
  if (!stats) {
    return null;
  }

  if (stats.isFile()) {
    if (shouldIgnoreBuildSourceFile(sourcePath)) {
      return null;
    }

    return { filePath: sourcePath, mtimeMs: stats.mtimeMs };
  }

  if (!stats.isDirectory()) {
    return null;
  }

  let latestFile = null;
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreBuildSourceEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(sourcePath, entry.name);
    const candidate = entry.isDirectory()
      ? await getLatestSourceFileEntry(entryPath)
      : shouldIgnoreBuildSourceFile(entryPath)
        ? null
        : await getLatestSourceFileEntry(entryPath);
    if (!candidate) {
      continue;
    }

    if (!latestFile || candidate.mtimeMs > latestFile.mtimeMs) {
      latestFile = candidate;
    }
  }

  return latestFile;
}

async function getLatestSourceFile(sourcePaths) {
  let latestFile = null;

  for (const sourcePath of sourcePaths) {
    const candidate = await getLatestSourceFileEntry(sourcePath);
    if (!candidate) {
      continue;
    }

    if (!latestFile || candidate.mtimeMs > latestFile.mtimeMs) {
      latestFile = candidate;
    }
  }

  return latestFile;
}

function createChecks(projectRoot, serverEntryPath = DEFAULT_SERVER_ENTRY_PATH) {
  return [
    {
      artifactPath: path.join(
        projectRoot,
        buildArtifactConfig.checks.frontend.artifactRelativePath,
      ),
      label: 'frontend',
      metadataPath: buildArtifactConfig.checks.frontend.metadataRelativePath
        ? path.join(projectRoot, buildArtifactConfig.checks.frontend.metadataRelativePath)
        : undefined,
      sourcePaths: buildArtifactConfig.checks.frontend.sourceRelativePaths.map((relativePath) =>
        path.join(projectRoot, relativePath),
      ),
      versionSourcePath: buildArtifactConfig.checks.frontend.versionSourceRelativePath
        ? path.join(projectRoot, buildArtifactConfig.checks.frontend.versionSourceRelativePath)
        : undefined,
    },
    {
      artifactPath: path.join(projectRoot, buildArtifactConfig.checks.remote.artifactRelativePath),
      label: 'remote',
      sourcePaths: buildArtifactConfig.checks.remote.sourceRelativePaths.map((relativePath) =>
        path.join(projectRoot, relativePath),
      ),
    },
    {
      artifactPath: serverEntryPath,
      label: 'server',
      sourcePaths: buildArtifactConfig.checks.server.sourceRelativePaths.map((relativePath) =>
        path.join(projectRoot, relativePath),
      ),
    },
  ];
}

function getArtifactStalenessLabel(status) {
  const staleLabels = [
    ...status.stale.map((check) => check.label),
    ...status.missing.map((check) => check.label),
  ];
  const stateLabel = status.missing.length > 0 ? 'missing or stale' : 'stale';
  return `${staleLabels.join(', ')} ${stateLabel}`;
}

async function readExpectedAppVersion(versionSourcePath) {
  const packageMetadata = await readJsonFile(versionSourcePath);
  return typeof packageMetadata?.version === 'string' ? packageMetadata.version : null;
}

async function readBuiltAppVersion(metadataPath) {
  const metadata = await readJsonFile(metadataPath);
  return typeof metadata?.appVersion === 'string' ? metadata.appVersion : null;
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getBrowserBuildArtifactStatus({
  projectRoot = PROJECT_ROOT,
  serverEntryPath = DEFAULT_SERVER_ENTRY_PATH,
} = {}) {
  const checks = createChecks(projectRoot, serverEntryPath);
  const results = await Promise.all(
    checks.map(async (check) => {
      const artifactStats = await stat(check.artifactPath).catch(() => null);
      if (!artifactStats) {
        return {
          artifactPath: check.artifactPath,
          kind: 'missing',
          label: check.label,
        };
      }

      const latestSourceFile = await getLatestSourceFile(check.sourcePaths);
      if (!latestSourceFile || latestSourceFile.mtimeMs <= artifactStats.mtimeMs) {
        if (check.metadataPath && check.versionSourcePath) {
          const [actualVersion, expectedVersion] = await Promise.all([
            readBuiltAppVersion(check.metadataPath),
            readExpectedAppVersion(check.versionSourcePath),
          ]);
          if (actualVersion !== expectedVersion) {
            return {
              artifactPath: check.artifactPath,
              kind: 'stale',
              label: check.label,
              latestSourceFile: latestSourceFile ?? {
                filePath: check.versionSourcePath,
                mtimeMs: artifactStats.mtimeMs,
              },
              staleReason: 'version-mismatch',
              versionDetails: {
                actualVersion,
                expectedVersion,
                metadataPath: check.metadataPath,
                versionSourcePath: check.versionSourcePath,
              },
            };
          }
        }

        return {
          artifactPath: check.artifactPath,
          kind: 'fresh',
          label: check.label,
          latestSourceFile,
        };
      }

      return {
        artifactPath: check.artifactPath,
        kind: 'stale',
        label: check.label,
        latestSourceFile,
        staleReason: 'source-newer',
      };
    }),
  );

  const missing = results.filter((check) => check.kind === 'missing');
  const stale = results.filter((check) => check.kind === 'stale');

  return {
    checks: results,
    missing,
    ok: missing.length === 0 && stale.length === 0,
    stale,
  };
}

function createSpawnRunner(env = process.env) {
  return async function runCommand(commandName, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(getCommandBin(commandName), args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
      });

      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) {
          resolve({ code: 1, signal });
          return;
        }

        resolve({ code: code ?? 1, signal: null });
      });
    });
  };
}

export async function runPlaywrightWithBrowserArtifacts({
  args = process.argv.slice(2),
  env = process.env,
  getStatus = getBrowserBuildArtifactStatus,
  projectRoot = PROJECT_ROOT,
  runCommand = createSpawnRunner(env),
  writeLine = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (!shouldCheckBrowserBuildArtifacts(env)) {
    writeLine('[browser-artifacts] Skipping browser artifact freshness check.');
    return runPlaywrightCommand(runCommand, args);
  }

  const status = await getStatus({
    projectRoot,
    serverEntryPath: getServerEntryPath(projectRoot),
  });

  if (!status.ok) {
    writeLine(
      `[browser-artifacts] ${getArtifactStalenessLabel(status)}; running prepare:browser-artifacts once.`,
    );
    const buildResult = await runCommand('npm', ['run', 'prepare:browser-artifacts']);
    if (buildResult.code !== 0) {
      return buildResult.code ?? 1;
    }
  } else {
    writeLine('[browser-artifacts] Browser artifacts are fresh; skipping rebuild.');
  }

  return runPlaywrightCommand(runCommand, args);
}

async function main() {
  const exitCode = await runPlaywrightWithBrowserArtifacts();
  process.exitCode = exitCode;
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedAsScript) {
  await main();
}
