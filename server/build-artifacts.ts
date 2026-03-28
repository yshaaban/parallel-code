import path from 'node:path';
import { access, readFile, readdir, stat } from 'node:fs/promises';

import buildArtifactConfig from './build-artifacts-config.json' with { type: 'json' };

const BUILD_REQUIRED_COMMAND =
  'Run `npm run build:frontend && npm run build:remote && npm run build:server`.';

type BuildArtifactLabel = 'frontend' | 'remote' | 'server';

interface LatestSourceFileEntry {
  filePath: string;
  mtimeMs: number;
}

interface BrowserBuildArtifactCheckConfig {
  artifactRelativePath: string;
  metadataRelativePath?: string;
  sourceRelativePaths: readonly string[];
  versionSourceRelativePath?: string;
}

interface BrowserBuildArtifactConfig {
  checks: Record<BuildArtifactLabel, BrowserBuildArtifactCheckConfig>;
  ignoredSourceDirs: readonly string[];
  ignoredSourceFilePatterns: readonly string[];
}

interface BuildArtifactCheck {
  artifactPath: string;
  label: BuildArtifactLabel;
  metadataPath?: string;
  sourcePaths: readonly string[];
  versionSourcePath?: string;
}

interface BuildArtifactCheckResultBase {
  artifactPath: string;
  label: BuildArtifactLabel;
}

export interface MissingBuildArtifactCheckResult extends BuildArtifactCheckResultBase {
  kind: 'missing';
}

export interface FreshBuildArtifactCheckResult extends BuildArtifactCheckResultBase {
  artifactMtimeMs: number;
  kind: 'fresh';
  latestSourceFile: LatestSourceFileEntry | null;
}

export interface StaleBuildArtifactCheckResult extends BuildArtifactCheckResultBase {
  artifactMtimeMs: number;
  kind: 'stale';
  latestSourceFile: LatestSourceFileEntry;
  staleReason: 'source-newer' | 'version-mismatch';
  versionDetails?: {
    actualVersion: string | null;
    expectedVersion: string | null;
    metadataPath: string;
    versionSourcePath: string;
  };
}

export type BuildArtifactCheckResult =
  | FreshBuildArtifactCheckResult
  | MissingBuildArtifactCheckResult
  | StaleBuildArtifactCheckResult;

export interface BrowserServerBuildArtifactOptions {
  projectRoot: string;
  serverEntryPath?: string;
}

export interface BrowserServerBuildArtifactStatus {
  checks: BuildArtifactCheckResult[];
  missingChecks: MissingBuildArtifactCheckResult[];
  ok: boolean;
  staleChecks: StaleBuildArtifactCheckResult[];
}

interface FrontendBuildMetadata {
  appVersion?: unknown;
}

const typedBuildArtifactConfig = buildArtifactConfig as BrowserBuildArtifactConfig;
const IGNORED_BUILD_SOURCE_DIRS = new Set(typedBuildArtifactConfig.ignoredSourceDirs);
const IGNORED_BUILD_SOURCE_FILE_PATTERNS = typedBuildArtifactConfig.ignoredSourceFilePatterns.map(
  (pattern) => new RegExp(pattern, 'u'),
);

export function shouldCheckBrowserServerBuildArtifacts(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK !== '1';
}

function shouldIgnoreBuildSourceEntry(name: string): boolean {
  return IGNORED_BUILD_SOURCE_DIRS.has(name);
}

function shouldIgnoreBuildSourceFile(filePath: string): boolean {
  return IGNORED_BUILD_SOURCE_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function createBuildChecks(options: BrowserServerBuildArtifactOptions): BuildArtifactCheck[] {
  function getArtifactPath(
    label: BuildArtifactLabel,
    config: BrowserBuildArtifactCheckConfig,
  ): string {
    if (label === 'server' && options.serverEntryPath) {
      return options.serverEntryPath;
    }

    return path.join(options.projectRoot, config.artifactRelativePath);
  }

  function createBuildCheck(label: BuildArtifactLabel): BuildArtifactCheck {
    const config = typedBuildArtifactConfig.checks[label];
    const buildCheck: BuildArtifactCheck = {
      artifactPath: getArtifactPath(label, config),
      label,
      sourcePaths: config.sourceRelativePaths.map((relativePath) =>
        path.join(options.projectRoot, relativePath),
      ),
    };

    if (config.metadataRelativePath) {
      buildCheck.metadataPath = path.join(options.projectRoot, config.metadataRelativePath);
    }

    if (config.versionSourceRelativePath) {
      buildCheck.versionSourcePath = path.join(
        options.projectRoot,
        config.versionSourceRelativePath,
      );
    }

    return buildCheck;
  }

  return (['frontend', 'remote', 'server'] as const).map(createBuildCheck);
}

function createMissingBuildArtifactCheckResult(
  check: BuildArtifactCheck,
): MissingBuildArtifactCheckResult {
  return {
    artifactPath: check.artifactPath,
    kind: 'missing',
    label: check.label,
  };
}

function createFreshBuildArtifactCheckResult(
  check: BuildArtifactCheck,
  artifactMtimeMs: number,
  latestSourceFile: LatestSourceFileEntry | null,
): FreshBuildArtifactCheckResult {
  return {
    artifactMtimeMs,
    artifactPath: check.artifactPath,
    kind: 'fresh',
    label: check.label,
    latestSourceFile,
  };
}

function createSourceNewerStaleBuildArtifactCheckResult(
  check: BuildArtifactCheck,
  artifactMtimeMs: number,
  latestSourceFile: LatestSourceFileEntry,
): StaleBuildArtifactCheckResult {
  return {
    artifactMtimeMs,
    artifactPath: check.artifactPath,
    kind: 'stale',
    label: check.label,
    latestSourceFile,
    staleReason: 'source-newer',
  };
}

function createVersionMismatchStaleBuildArtifactCheckResult(
  check: BuildArtifactCheck,
  artifactMtimeMs: number,
  latestSourceFile: LatestSourceFileEntry | null,
  actualVersion: string | null,
  expectedVersion: string | null,
): StaleBuildArtifactCheckResult {
  if (!check.metadataPath || !check.versionSourcePath) {
    throw new Error('Version mismatch result requires metadata and version source paths.');
  }

  return {
    artifactMtimeMs,
    artifactPath: check.artifactPath,
    kind: 'stale',
    label: check.label,
    latestSourceFile: latestSourceFile ?? {
      filePath: check.versionSourcePath,
      mtimeMs: artifactMtimeMs,
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

async function getLatestSourceFileEntry(sourcePath: string): Promise<LatestSourceFileEntry | null> {
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

  let latestFile: LatestSourceFileEntry | null = null;
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreBuildSourceEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(sourcePath, entry.name);
    if (!entry.isDirectory() && shouldIgnoreBuildSourceFile(entryPath)) {
      continue;
    }

    const candidate = await getLatestSourceFileEntry(entryPath);
    if (!candidate) {
      continue;
    }

    if (!latestFile || candidate.mtimeMs > latestFile.mtimeMs) {
      latestFile = candidate;
    }
  }

  return latestFile;
}

async function getLatestSourceFile(
  sourcePaths: readonly string[],
): Promise<LatestSourceFileEntry | null> {
  let latestFile: LatestSourceFileEntry | null = null;

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

async function readExpectedAppVersion(versionSourcePath: string): Promise<string | null> {
  const packageMetadata = (await readJsonFile(versionSourcePath)) as { version?: unknown } | null;
  return typeof packageMetadata?.version === 'string' ? packageMetadata.version : null;
}

async function readBuiltAppVersion(metadataPath: string): Promise<string | null> {
  const metadata = (await readJsonFile(metadataPath)) as FrontendBuildMetadata | null;
  return typeof metadata?.appVersion === 'string' ? metadata.appVersion : null;
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function getBuildArtifactCheckResult(
  check: BuildArtifactCheck,
): Promise<BuildArtifactCheckResult> {
  const buildArtifactStats = await stat(check.artifactPath).catch(() => null);
  if (!buildArtifactStats) {
    return createMissingBuildArtifactCheckResult(check);
  }

  const latestSourceFile = await getLatestSourceFile(check.sourcePaths);
  if (!latestSourceFile || latestSourceFile.mtimeMs <= buildArtifactStats.mtimeMs) {
    if (check.metadataPath && check.versionSourcePath) {
      const [actualVersion, expectedVersion] = await Promise.all([
        readBuiltAppVersion(check.metadataPath),
        readExpectedAppVersion(check.versionSourcePath),
      ]);

      if (actualVersion !== expectedVersion) {
        return createVersionMismatchStaleBuildArtifactCheckResult(
          check,
          buildArtifactStats.mtimeMs,
          latestSourceFile,
          actualVersion,
          expectedVersion,
        );
      }
    }

    return createFreshBuildArtifactCheckResult(check, buildArtifactStats.mtimeMs, latestSourceFile);
  }

  return createSourceNewerStaleBuildArtifactCheckResult(
    check,
    buildArtifactStats.mtimeMs,
    latestSourceFile,
  );
}

export async function getBrowserServerBuildArtifactStatus(
  options: BrowserServerBuildArtifactOptions,
): Promise<BrowserServerBuildArtifactStatus> {
  const checks = await Promise.all(createBuildChecks(options).map(getBuildArtifactCheckResult));
  const missingChecks = checks.filter(isMissingBuildArtifactCheckResult);
  const staleChecks = checks.filter(isStaleBuildArtifactCheckResult);

  return {
    checks,
    missingChecks,
    ok: missingChecks.length === 0 && staleChecks.length === 0,
    staleChecks,
  };
}

function isMissingBuildArtifactCheckResult(
  check: BuildArtifactCheckResult,
): check is MissingBuildArtifactCheckResult {
  return check.kind === 'missing';
}

function isStaleBuildArtifactCheckResult(
  check: BuildArtifactCheckResult,
): check is StaleBuildArtifactCheckResult {
  return check.kind === 'stale';
}

function formatMissingArtifactsMessage(
  options: BrowserServerBuildArtifactOptions,
  missingChecks: readonly MissingBuildArtifactCheckResult[],
): string {
  const frontendArtifactPath = path.relative(
    process.cwd(),
    path.join(options.projectRoot, typedBuildArtifactConfig.checks.frontend.artifactRelativePath),
  );
  const remoteArtifactPath = path.relative(
    process.cwd(),
    path.join(options.projectRoot, typedBuildArtifactConfig.checks.remote.artifactRelativePath),
  );

  return [
    'Browser server build artifacts are missing.',
    `Expected ${frontendArtifactPath} and ${remoteArtifactPath}.`,
    `Missing: ${missingChecks.map((check) => path.relative(process.cwd(), check.artifactPath)).join(', ')}.`,
    BUILD_REQUIRED_COMMAND,
  ].join(' ');
}

function formatStaleArtifactsMessage(
  staleChecks: readonly StaleBuildArtifactCheckResult[],
): string {
  const firstStaleCheck = staleChecks[0];
  if (!firstStaleCheck) {
    return `Browser server build artifacts are stale. ${BUILD_REQUIRED_COMMAND}`;
  }

  if (firstStaleCheck.staleReason === 'version-mismatch' && firstStaleCheck.versionDetails) {
    return [
      `Browser server ${firstStaleCheck.label} build artifact is stale.`,
      `Built version: ${firstStaleCheck.versionDetails.actualVersion ?? 'missing'}`,
      `Expected version: ${firstStaleCheck.versionDetails.expectedVersion ?? 'missing'}`,
      `Built metadata: ${path.relative(process.cwd(), firstStaleCheck.versionDetails.metadataPath)}`,
      `Version source: ${path.relative(process.cwd(), firstStaleCheck.versionDetails.versionSourcePath)}`,
      BUILD_REQUIRED_COMMAND,
    ].join(' ');
  }

  return [
    `Browser server ${firstStaleCheck.label} build artifact is stale.`,
    `Newest source: ${path.relative(process.cwd(), firstStaleCheck.latestSourceFile.filePath)}`,
    `Built artifact: ${path.relative(process.cwd(), firstStaleCheck.artifactPath)}`,
    BUILD_REQUIRED_COMMAND,
  ].join(' ');
}

export async function assertBrowserServerBuildArtifactsAreFresh(
  options: BrowserServerBuildArtifactOptions,
): Promise<void> {
  const status = await getBrowserServerBuildArtifactStatus(options);

  if (status.ok) {
    return;
  }

  if (status.missingChecks.length > 0) {
    throw new Error(formatMissingArtifactsMessage(options, status.missingChecks));
  }

  throw new Error(formatStaleArtifactsMessage(status.staleChecks));
}

export async function assertBrowserServerBuildArtifactsExist(
  options: BrowserServerBuildArtifactOptions,
): Promise<void> {
  const checks = createBuildChecks(options);
  await Promise.all(checks.map((check) => access(check.artifactPath))).catch(() => {
    throw new Error(
      formatMissingArtifactsMessage(
        options,
        checks.map((check) => ({
          artifactPath: check.artifactPath,
          kind: 'missing' as const,
          label: check.label,
        })),
      ),
    );
  });
}
