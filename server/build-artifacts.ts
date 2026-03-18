import path from 'node:path';
import { access, readdir, stat } from 'node:fs/promises';

const BUILD_REQUIRED_COMMAND =
  'Run `npm run build:frontend && npm run build:remote && npm run build:server`.';
const IGNORED_BUILD_SOURCE_DIRS = new Set([
  '.git',
  '.playwright-browser-lab',
  '.sentrux',
  'dist',
  'dist-remote',
  'dist-server',
  'node_modules',
  'release',
  'test-results',
]);
const IGNORED_BUILD_SOURCE_FILE_PATTERNS = [/\.spec\.[cm]?[jt]sx?$/u, /\.test\.[cm]?[jt]sx?$/u];

interface BuildArtifactCheck {
  artifactPath: string;
  label: 'frontend' | 'remote' | 'server';
  sourcePaths: readonly string[];
}

interface LatestSourceFileEntry {
  filePath: string;
  mtimeMs: number;
}

export interface BrowserServerBuildArtifactOptions {
  projectRoot: string;
  serverEntryPath?: string;
}

function shouldIgnoreBuildSourceEntry(name: string): boolean {
  return IGNORED_BUILD_SOURCE_DIRS.has(name);
}

function shouldIgnoreBuildSourceFile(filePath: string): boolean {
  return IGNORED_BUILD_SOURCE_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
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

async function assertBuildArtifactIsFresh(check: BuildArtifactCheck): Promise<void> {
  const [buildArtifactStats, latestSourceFile] = await Promise.all([
    stat(check.artifactPath),
    getLatestSourceFile(check.sourcePaths),
  ]);

  if (!latestSourceFile || latestSourceFile.mtimeMs <= buildArtifactStats.mtimeMs) {
    return;
  }

  throw new Error(
    [
      `Browser server ${check.label} build artifact is stale.`,
      `Newest source: ${path.relative(process.cwd(), latestSourceFile.filePath)}`,
      `Built artifact: ${path.relative(process.cwd(), check.artifactPath)}`,
      BUILD_REQUIRED_COMMAND,
    ].join(' '),
  );
}

export async function assertBrowserServerBuildArtifactsAreFresh(
  options: BrowserServerBuildArtifactOptions,
): Promise<void> {
  const distDir = path.join(options.projectRoot, 'dist');
  const distRemoteDir = path.join(options.projectRoot, 'dist-remote');
  const frontendIndexPath = path.join(distDir, 'index.html');
  const remoteIndexPath = path.join(distRemoteDir, 'index.html');
  const requiredArtifacts = [frontendIndexPath, remoteIndexPath];

  if (options.serverEntryPath) {
    requiredArtifacts.push(options.serverEntryPath);
  }

  await Promise.all(requiredArtifacts.map((artifactPath) => access(artifactPath))).catch(() => {
    throw new Error(
      [
        'Browser server build artifacts are missing.',
        `Expected ${path.relative(process.cwd(), frontendIndexPath)} and ${path.relative(process.cwd(), remoteIndexPath)}.`,
        BUILD_REQUIRED_COMMAND,
      ].join(' '),
    );
  });

  const buildChecks: BuildArtifactCheck[] = [
    {
      artifactPath: frontendIndexPath,
      label: 'frontend',
      sourcePaths: [
        path.join(options.projectRoot, 'src'),
        path.join(options.projectRoot, 'electron'),
        path.join(options.projectRoot, 'package.json'),
        path.join(options.projectRoot, 'tsconfig.json'),
      ],
    },
    {
      artifactPath: remoteIndexPath,
      label: 'remote',
      sourcePaths: [
        path.join(options.projectRoot, 'src', 'remote'),
        path.join(options.projectRoot, 'package.json'),
      ],
    },
  ];

  if (options.serverEntryPath) {
    buildChecks.push({
      artifactPath: options.serverEntryPath,
      label: 'server',
      sourcePaths: [
        path.join(options.projectRoot, 'server'),
        path.join(options.projectRoot, 'electron'),
        path.join(options.projectRoot, 'src', 'ipc'),
        path.join(options.projectRoot, 'src', 'domain'),
        path.join(options.projectRoot, 'package.json'),
        path.join(options.projectRoot, 'tsconfig.json'),
      ],
    });
  }

  await Promise.all(buildChecks.map((check) => assertBuildArtifactIsFresh(check)));
}
