#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifyReleaseArtifactPath } from './lib/release-artifact-policy.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SEED_PATH = 'scripts/task-notes-proof-seed.json';
const REPORT_FORMAT_VERSION = 1;
const WRITER_TRAINS = new Set(['dark', 'desktop', 'remote']);
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const require = createRequire(import.meta.url);
const ts = require('typescript');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function git(projectRoot, args, options = {}) {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: options.encoding === 'buffer' ? null : (options.encoding ?? 'utf8'),
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCandidate(projectRoot, candidate) {
  return git(projectRoot, ['rev-parse', '--verify', `${candidate}^{commit}`]).trim();
}

function listCandidateFiles(projectRoot, candidateSha) {
  const output = git(projectRoot, ['ls-tree', '-r', '-z', '--full-tree', candidateSha], {
    encoding: 'buffer',
  });
  const files = new Map();
  for (const entry of output.toString('utf8').split('\0')) {
    if (!entry) continue;
    const match = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/u.exec(entry);
    if (!match || match[2] !== 'blob') continue;
    files.set(match[4], { mode: match[1], oid: match[3] });
  }
  return files;
}

function readCandidateFile(projectRoot, candidateSha, filePath) {
  return git(projectRoot, ['show', `${candidateSha}:${filePath}`], { encoding: 'buffer' });
}

function readCandidateFileBatch(projectRoot, candidateFiles, filePaths) {
  const oids = [
    ...new Set(filePaths.map((filePath) => candidateFiles.get(filePath)?.oid).filter(Boolean)),
  ];
  if (oids.length === 0) return new Map();
  const output = execFileSync('git', ['-C', projectRoot, 'cat-file', '--batch'], {
    encoding: null,
    input: `${oids.join('\n')}\n`,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const blobsByOid = new Map();
  let offset = 0;
  for (const requestedOid of oids) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`Missing git blob header for ${requestedOid}`);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const match = /^([0-9a-f]+) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== requestedOid) {
      throw new Error(`Unexpected git blob header for ${requestedOid}: ${header}`);
    }
    const byteLength = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + byteLength;
    if (contentEnd >= output.byteLength || output[contentEnd] !== 0x0a) {
      throw new Error(`Truncated git blob for ${requestedOid}`);
    }
    blobsByOid.set(requestedOid, output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.byteLength) throw new Error('Unexpected trailing git blob data');

  const blobsByPath = new Map();
  for (const filePath of filePaths) {
    const oid = candidateFiles.get(filePath)?.oid;
    if (oid) blobsByPath.set(filePath, blobsByOid.get(oid));
  }
  return blobsByPath;
}

function parseSeed(buffer) {
  const seed = JSON.parse(buffer.toString('utf8'));
  const arrayFields = [
    'artifactRoots',
    'commands',
    'entrypoints',
    'includeFiles',
    'includePathPatterns',
    'includePrefixes',
  ];
  const expectedFields = ['formatVersion', ...arrayFields].sort();
  if (
    !seed ||
    typeof seed !== 'object' ||
    Array.isArray(seed) ||
    Object.keys(seed).sort().join(',') !== expectedFields.join(',') ||
    seed.formatVersion !== REPORT_FORMAT_VERSION ||
    arrayFields.some(
      (field) =>
        !Array.isArray(seed[field]) ||
        seed[field].some((entry) => typeof entry !== 'string' || entry.length === 0) ||
        new Set(seed[field]).size !== seed[field].length,
    )
  ) {
    throw new Error('Task notes proof seed is invalid');
  }
  if (
    seed.artifactRoots.length === 0 ||
    seed.commands.length === 0 ||
    seed.entrypoints.length === 0
  ) {
    throw new Error('Task notes proof seed requires artifacts, commands, and entrypoints');
  }
  return seed;
}

function safePatterns(seed) {
  return seed.includePathPatterns.map((pattern) => new RegExp(pattern, 'u'));
}

function assertSafeRepositoryPath(filePath, label) {
  if (
    !filePath ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    path.posix.normalize(filePath) !== filePath ||
    filePath.startsWith('../')
  ) {
    throw new Error(`${label} contains an unsafe repository path: ${filePath}`);
  }
}

function candidateImportPaths(fromPath, specifier) {
  const withoutQuery = specifier.split(/[?#]/u, 1)[0];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), withoutQuery));
  const extension = path.posix.extname(base);
  const candidates = [base];
  if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  } else if (!extension) {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}.json`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
    );
  }
  return [...new Set(candidates)];
}

export function resolveRelativeImport(fromPath, specifier, candidatePaths) {
  if (!specifier.startsWith('.')) return null;
  return candidateImportPaths(fromPath, specifier).find((candidate) =>
    candidatePaths.has(candidate),
  );
}

function parseImports(source, filePath) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function addLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addLiteral(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) addLiteral(argument.literal);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(
          `Nonliteral dynamic import in ${filePath}:${position.line + 1}:${position.character + 1}`,
        );
      }
      addLiteral(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(
          `Nonliteral require in ${filePath}:${position.line + 1}:${position.character + 1}`,
        );
      }
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(specifiers)].sort();
}

function externalPackage(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function roleForPath(filePath, entrypoints) {
  if (filePath === SEED_PATH) return 'seed';
  if (/(?:^|\/)fixtures?(?:\/|\.)/u.test(filePath)) return 'fixture';
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filePath)) return 'test';
  if (/^(?:\.github\/|scripts\/|.*config\.|package(?:-lock)?\.json|.*tsconfig)/u.test(filePath)) {
    return 'proof-input';
  }
  if (entrypoints.has(filePath)) return 'production-root';
  return 'dependency';
}

function validateSeedPaths(seed, candidateFiles) {
  for (const filePath of [...seed.entrypoints, ...seed.includeFiles]) {
    assertSafeRepositoryPath(filePath, 'Seed');
    if (!candidateFiles.has(filePath)) throw new Error(`Proof seed file is missing: ${filePath}`);
  }
  for (const prefix of seed.includePrefixes) {
    assertSafeRepositoryPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix, 'Seed prefix');
  }
  for (const artifactRoot of seed.artifactRoots) {
    assertSafeRepositoryPath(artifactRoot, 'Artifact root');
  }
}

function getSelectedSeedFiles(seed, candidateFiles) {
  const patterns = safePatterns(seed);
  const selected = new Set([...seed.entrypoints, ...seed.includeFiles, SEED_PATH]);
  for (const filePath of candidateFiles.keys()) {
    if (
      seed.includePrefixes.some((prefix) => filePath.startsWith(prefix)) ||
      patterns.some((pattern) => pattern.test(filePath))
    ) {
      selected.add(filePath);
    }
  }
  return selected;
}

function toolchainFor(projectRoot, readCandidate) {
  const packageJson = JSON.parse(readCandidate('package.json').toString('utf8'));
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const electron = require('electron/package.json');
  const playwright = require('@playwright/test/package.json');
  const playwrightBrowsers = JSON.parse(
    readFileSync(
      path.join(path.dirname(require.resolve('playwright-core')), 'browsers.json'),
      'utf8',
    ),
  );
  const chromium = playwrightBrowsers.browsers.find((browser) => browser.name === 'chromium');
  if (!chromium) throw new Error('Installed Playwright does not declare Chromium');
  return {
    arch: process.arch,
    electron: electron.version,
    node: process.version,
    npm: npmVersion,
    osRelease: os.release(),
    packageManager: packageJson.packageManager ?? null,
    platform: process.platform,
    playwright: playwright.version,
    playwrightChromium: {
      browserVersion: chromium.browserVersion,
      revision: chromium.revision,
    },
  };
}

export function assertRelevantWorktreeClean({
  projectRoot,
  relevantFiles,
  includePrefixes,
  includePathPatterns,
}) {
  const output = git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = output.split('\0').filter(Boolean);
  const patterns = includePathPatterns.map((pattern) => new RegExp(pattern, 'u'));
  const dirty = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    const paths = [filePath];
    if (status.includes('R') || status.includes('C')) paths.push(entries[++index] ?? '');
    if (
      paths.some(
        (candidate) =>
          relevantFiles.has(candidate) ||
          includePrefixes.some((prefix) => candidate.startsWith(prefix)) ||
          patterns.some((pattern) => pattern.test(candidate)),
      )
    ) {
      dirty.push(`${status} ${paths.filter(Boolean).join(' -> ')}`);
    }
  }
  if (dirty.length > 0) {
    throw new Error(
      `Relevant task-notes proof inputs are dirty or untracked:\n${dirty.slice(0, 25).join('\n')}`,
    );
  }
}

export function buildSourceSnapshot({ projectRoot, candidate = 'HEAD', requireClean = true }) {
  const candidateSha = resolveCandidate(projectRoot, candidate);
  const candidateFiles = listCandidateFiles(projectRoot, candidateSha);
  if (!candidateFiles.has(SEED_PATH)) throw new Error(`Candidate is missing ${SEED_PATH}`);
  const seed = parseSeed(readCandidateFile(projectRoot, candidateSha, SEED_PATH));
  validateSeedPaths(seed, candidateFiles);
  const seedFiles = getSelectedSeedFiles(seed, candidateFiles);
  const preloadPaths = [...candidateFiles.keys()].filter(
    (filePath) => SOURCE_EXTENSIONS.has(path.posix.extname(filePath)) || seedFiles.has(filePath),
  );
  const preloadedFiles = readCandidateFileBatch(projectRoot, candidateFiles, preloadPaths);
  const readCandidate = (filePath) =>
    preloadedFiles.get(filePath) ?? readCandidateFile(projectRoot, candidateSha, filePath);
  const relevantFiles = new Set(seedFiles);
  const edges = [];
  const queue = [...seedFiles].sort();
  const visited = new Set();

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    if (!SOURCE_EXTENSIONS.has(path.posix.extname(filePath))) continue;
    const source = readCandidate(filePath).toString('utf8');
    for (const specifier of parseImports(source, filePath)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(filePath, specifier, candidateFiles);
        if (!resolved) throw new Error(`Unresolved relative import ${specifier} from ${filePath}`);
        edges.push({ from: filePath, specifier, to: resolved });
        if (!relevantFiles.has(resolved)) {
          relevantFiles.add(resolved);
          queue.push(resolved);
          queue.sort();
        }
      } else {
        edges.push({ from: filePath, specifier, to: `external:${externalPackage(specifier)}` });
      }
    }
  }

  if (requireClean) {
    assertRelevantWorktreeClean({
      projectRoot,
      relevantFiles,
      includePrefixes: seed.includePrefixes,
      includePathPatterns: seed.includePathPatterns,
    });
  }

  const entrypoints = new Set(seed.entrypoints);
  const files = [...relevantFiles].sort().map((filePath) => {
    const bytes = readCandidate(filePath);
    return {
      bytes: bytes.byteLength,
      mode: candidateFiles.get(filePath).mode,
      path: filePath,
      role: roleForPath(filePath, entrypoints),
      sha256: sha256(bytes),
    };
  });
  const sortedEdges = edges.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  const toolchain = toolchainFor(projectRoot, readCandidate);
  const fixtureSeedFiles = files.filter((file) => file.role === 'fixture' || file.role === 'seed');
  const digests = {
    commandManifestDigest: sha256(canonicalJson(seed.commands)),
    dependencyEdgeDigest: sha256(canonicalJson(sortedEdges)),
    fixtureSeedDigest: sha256(canonicalJson(fixtureSeedFiles)),
    relevantTreeDigest: sha256(canonicalJson(files)),
    toolchainDigest: sha256(canonicalJson(toolchain)),
  };
  const source = {
    dependencyEdges: sortedEdges,
    files,
    toolchain,
  };
  const sourceManifestDigest = sha256(canonicalJson(digests));
  return {
    candidateSha,
    digests: { ...digests, sourceManifestDigest },
    seed,
    source,
  };
}

async function walkArtifacts(projectRoot, roots) {
  const records = [];
  async function visit(relativePath) {
    const absolutePath = path.join(projectRoot, relativePath);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Task notes proof artifact cannot be a symbolic link: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      const entries = await readdir(absolutePath);
      for (const entry of entries.sort()) await visit(path.posix.join(relativePath, entry));
      return;
    }
    if (!stats.isFile()) throw new Error(`Unsupported proof artifact: ${relativePath}`);
    const bytes = await readFile(absolutePath);
    records.push({
      bytes: bytes.byteLength,
      kind: 'file',
      path: relativePath,
      sha256: sha256(bytes),
    });
  }
  for (const root of roots) await visit(root);
  if (records.length === 0) throw new Error('Task notes proof artifact set is empty');
  return records;
}

function assertSafePromotionArtifactPath(filePath) {
  assertSafeRepositoryPath(filePath, 'Promotion artifact');
  if (classifyReleaseArtifactPath(filePath) === null) {
    throw new Error(
      `Promotion artifact is not an approved release package or app.asar: ${filePath}`,
    );
  }
}

async function lstatWithoutSymlinkAncestors(projectRoot, relativePath) {
  let currentPath = projectRoot;
  let stats;
  for (const segment of relativePath.split('/')) {
    currentPath = path.join(currentPath, segment);
    stats = await lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Promotion artifact path cannot contain a symbolic link: ${relativePath}`);
    }
  }
  return stats;
}

async function hashPromotionArtifacts(projectRoot, filePaths) {
  if (new Set(filePaths).size !== filePaths.length) {
    throw new Error('Promotion artifact paths must be unique');
  }
  const records = [];
  for (const relativePath of [...filePaths].sort()) {
    assertSafePromotionArtifactPath(relativePath);
    const absolutePath = path.join(projectRoot, relativePath);
    const stats = await lstatWithoutSymlinkAncestors(projectRoot, relativePath);
    if (!stats.isFile()) {
      throw new Error(`Promotion artifact must be a regular file: ${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    records.push({
      bytes: bytes.byteLength,
      path: relativePath,
      sha256: sha256(bytes),
    });
  }
  return records;
}

function getReportPromotionArtifactPaths(report) {
  if (!Array.isArray(report.promotionArtifacts)) {
    throw new Error('Task notes proof report promotion artifacts are invalid');
  }
  return report.promotionArtifacts.map((record) => {
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(',') !== 'bytes,path,sha256' ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      typeof record.path !== 'string' ||
      typeof record.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.sha256)
    ) {
      throw new Error('Task notes proof report promotion artifact record is invalid');
    }
    assertSafePromotionArtifactPath(record.path);
    return record.path;
  });
}

export function validateCommandEvidence(value, expectedCommands) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.commands) ||
    value.commands.length !== expectedCommands.length
  ) {
    throw new Error('Task notes command evidence is incomplete');
  }
  return value.commands.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'command,exitCode' ||
      entry.command !== expectedCommands[index] ||
      entry.exitCode !== 0
    ) {
      throw new Error(`Task notes command evidence failed at command ${index + 1}`);
    }
    return { command: entry.command, exitCode: 0 };
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function parseArgs(argv) {
  const knownArguments = new Set([
    '--candidate',
    '--command-evidence',
    '--pre-snapshot',
    '--promotion-artifact',
    '--verify-report',
    '--write-report',
    '--write-snapshot',
    '--writer-train',
  ]);
  const values = new Map();
  const promotionArtifacts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    if (!knownArguments.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (argument === '--promotion-artifact') {
      promotionArtifacts.push(value);
    } else {
      if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      values.set(argument, value);
    }
    index += 1;
  }
  const candidate = values.get('--candidate') ?? 'HEAD';
  const actions = ['--write-snapshot', '--write-report', '--verify-report'].filter((key) =>
    values.has(key),
  );
  if (actions.length !== 1) {
    throw new Error('Choose exactly one of --write-snapshot, --write-report, or --verify-report');
  }
  const allowedArguments = new Set(['--candidate', actions[0]]);
  if (actions[0] === '--write-report') {
    allowedArguments.add('--pre-snapshot');
    allowedArguments.add('--command-evidence');
    allowedArguments.add('--writer-train');
  }
  for (const argument of values.keys()) {
    if (!allowedArguments.has(argument)) {
      throw new Error(`${argument} is not valid with ${actions[0]}`);
    }
  }
  if (actions[0] !== '--write-report' && promotionArtifacts.length > 0) {
    throw new Error(`--promotion-artifact is not valid with ${actions[0]}`);
  }
  return { action: actions[0], candidate, promotionArtifacts, values };
}

function sourceSnapshotEnvelope(snapshot) {
  return {
    candidate: snapshot.candidateSha,
    digests: snapshot.digests,
    formatVersion: REPORT_FORMAT_VERSION,
    kind: 'task-notes-proof-source-snapshot',
    source: snapshot.source,
  };
}

function formattedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildTaskNotesProofReport({
  projectRoot,
  snapshot,
  evidence,
  writerTrain = 'dark',
  promotionArtifactPaths = [],
}) {
  if (!WRITER_TRAINS.has(writerTrain)) {
    throw new Error('Task notes proof report writer train is invalid');
  }
  const artifacts = await walkArtifacts(projectRoot, snapshot.seed.artifactRoots);
  const promotionArtifacts = await hashPromotionArtifacts(projectRoot, promotionArtifactPaths);
  if (writerTrain !== 'dark' && promotionArtifacts.length === 0) {
    throw new Error('Desktop and remote writer reports require a promotion artifact');
  }
  if (writerTrain === 'dark' && promotionArtifacts.length > 0) {
    throw new Error('Dark proof reports cannot bind promotion artifacts');
  }
  const artifactDigest = sha256(canonicalJson({ artifacts, promotionArtifacts }));
  const body = {
    artifacts,
    candidate: snapshot.candidateSha,
    commands: evidence,
    digests: { ...snapshot.digests, artifactDigest },
    formatVersion: REPORT_FORMAT_VERSION,
    kind: 'task-notes-proof-report',
    promotionArtifacts,
    source: snapshot.source,
    writerTrain,
  };
  return { ...body, proofDigest: sha256(canonicalJson(body)) };
}

export async function verifyTaskNotesProofReport(projectRoot, snapshot, expected) {
  if (
    !expected ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    expected.kind !== 'task-notes-proof-report' ||
    expected.formatVersion !== REPORT_FORMAT_VERSION ||
    typeof expected.proofDigest !== 'string' ||
    !WRITER_TRAINS.has(expected.writerTrain)
  ) {
    throw new Error('Task notes proof report has an unsupported envelope');
  }
  const { proofDigest, ...expectedBody } = expected;
  if (sha256(canonicalJson(expectedBody)) !== proofDigest) {
    throw new Error('Task notes proof report digest is invalid');
  }
  const evidence = validateCommandEvidence({ commands: expected.commands }, snapshot.seed.commands);
  const promotionArtifactPaths = getReportPromotionArtifactPaths(expected);
  const current = await buildTaskNotesProofReport({
    evidence,
    projectRoot,
    promotionArtifactPaths,
    snapshot,
    writerTrain: expected.writerTrain,
  });
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error('Task notes proof report is stale for current source, toolchain, or artifacts');
  }
  return current;
}

export function getTaskNotesProofReportIdentity(report) {
  if (
    !report ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    report.formatVersion !== REPORT_FORMAT_VERSION ||
    (report.writerTrain !== 'desktop' && report.writerTrain !== 'remote') ||
    typeof report.proofDigest !== 'string' ||
    !report.digests ||
    typeof report.digests !== 'object' ||
    Array.isArray(report.digests)
  ) {
    throw new Error('Task notes proof report cannot authorize a writer train');
  }
  const digestNames = [
    'artifactDigest',
    'commandManifestDigest',
    'dependencyEdgeDigest',
    'fixtureSeedDigest',
    'relevantTreeDigest',
    'sourceManifestDigest',
    'toolchainDigest',
  ];
  for (const name of digestNames) {
    if (typeof report.digests[name] !== 'string' || !/^[0-9a-f]{64}$/u.test(report.digests[name])) {
      throw new Error(`Task notes proof report ${name} is invalid`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(report.proofDigest)) {
    throw new Error('Task notes proof report proofDigest is invalid');
  }
  return Object.freeze({
    artifactDigest: report.digests.artifactDigest,
    commandManifestDigest: report.digests.commandManifestDigest,
    dependencyEdgeDigest: report.digests.dependencyEdgeDigest,
    fixtureSeedDigest: report.digests.fixtureSeedDigest,
    formatVersion: REPORT_FORMAT_VERSION,
    proofDigest: report.proofDigest,
    relevantTreeDigest: report.digests.relevantTreeDigest,
    sourceManifestDigest: report.digests.sourceManifestDigest,
    toolchainDigest: report.digests.toolchainDigest,
    writerTrain: report.writerTrain,
  });
}

export async function runTaskNotesProofManifest(projectRoot, argv) {
  const { action, candidate, promotionArtifacts, values } = parseArgs(argv);
  const snapshot = buildSourceSnapshot({ projectRoot, candidate });
  if (action === '--write-snapshot') {
    const output = values.get(action);
    await writeFile(output, formattedJson(sourceSnapshotEnvelope(snapshot)));
    return `task-notes-proof source=${snapshot.digests.sourceManifestDigest}`;
  }

  if (action === '--write-report') {
    const preSnapshotPath = values.get('--pre-snapshot');
    const evidencePath = values.get('--command-evidence');
    if (!preSnapshotPath || !evidencePath) {
      throw new Error('--write-report requires --pre-snapshot and --command-evidence');
    }
    const preSnapshotText = await readFile(preSnapshotPath, 'utf8');
    if (preSnapshotText !== formattedJson(sourceSnapshotEnvelope(snapshot))) {
      throw new Error('Pre-run task notes source snapshot is stale or from another toolchain');
    }
    const commandEvidence = validateCommandEvidence(
      await readJson(evidencePath),
      snapshot.seed.commands,
    );
    const report = await buildTaskNotesProofReport({
      evidence: commandEvidence,
      projectRoot,
      promotionArtifactPaths: promotionArtifacts,
      snapshot,
      writerTrain: values.get('--writer-train') ?? 'dark',
    });
    await writeFile(values.get(action), formattedJson(report));
    return `task-notes-proof source=${snapshot.digests.sourceManifestDigest} proof=${report.proofDigest}`;
  }

  const expected = await readJson(values.get(action));
  const current = await verifyTaskNotesProofReport(projectRoot, snapshot, expected);
  return `task-notes-proof verified=${current.proofDigest}`;
}

async function main() {
  const result = await runTaskNotesProofManifest(PROJECT_ROOT, process.argv.slice(2));
  process.stdout.write(`${result}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
