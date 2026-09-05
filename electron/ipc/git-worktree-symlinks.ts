import fs from 'fs';
import path from 'path';

import type {
  WorktreeSymlinkCandidate,
  WorktreeSymlinkCandidatesResult,
  WorktreeSymlinkWarning,
  WorktreeSymlinkWarningReason,
} from '../../src/ipc/types.js';
import { isWellFormedUnicodeScalarString } from '../../src/lib/unicode-scalar.js';
import { BadRequestError } from './errors.js';
import { withWorktreeLock } from './git-cache.js';
import { execGit, execGitBuffer } from './git-exec.js';

export const MAX_WORKTREE_SYMLINK_REQUEST_NAMES = 128;
export const MAX_WORKTREE_SYMLINK_NAME_BYTES = 255;
export const MAX_WORKTREE_SYMLINK_REQUEST_BYTES = 16 * 1024;
export const WORKTREE_SYMLINK_GIT_TIMEOUT_MS = 3_000;
export const WORKTREE_SYMLINK_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const DEFAULT_WORKTREE_SYMLINK_NAMES = Object.freeze([
  '.claude',
  '.cursor',
  '.aider',
  '.copilot',
  '.codeium',
  '.continue',
  '.windsurf',
  '.env',
  'node_modules',
] as const);

const RESERVED_WORKTREE_SYMLINK_NAMES = Object.freeze(['.git', '.worktrees'] as const);
const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'settings.local.json']);
const EXCLUDE_HEADER = '# Parallel Code shared worktree links';
const TASK_WORKTREE_LINK_REQUEST_V1 = Symbol('TaskWorktreeLinkRequestV1');
const WORKTREE_SYMLINK_WARNING_DETAILS: Readonly<Record<WorktreeSymlinkWarningReason, string>> =
  Object.freeze({
    candidate_query_failed: 'Git could not re-check whether it is still an eligible ignored entry',
    destination_exists: 'the new worktree already contains an entry with that name',
    exclude_update_failed: "the repository's shared Git exclude file could not be updated safely",
    ignore_postcondition_failed: 'Git did not confirm that the created link is ignored',
    invalid_name: 'the requested name is not a safe direct project-root entry',
    link_failed: 'the filesystem link could not be created and verified safely',
    not_current_candidate: 'Git no longer reports it as an ignored, untracked root entry',
    reserved_name: 'the name is reserved for Git or Parallel Code worktree metadata',
    source_missing: 'the project-root source no longer exists',
    source_symlink: 'the project-root source is itself a symbolic link',
    unsupported_source_kind: 'the project-root source is not a regular file or directory',
  });

export interface TaskWorktreeLinkRequestV1 {
  readonly [TASK_WORKTREE_LINK_REQUEST_V1]: true;
  readonly format: 1;
  readonly names: readonly string[];
  readonly encodedBytes: Readonly<Uint8Array>;
  readonly encodedLength: number;
}

export interface ApplyRequestedWorktreeSymlinksResult {
  warnings: WorktreeSymlinkWarning[];
}

export class WorktreeSymlinkSafetyError extends Error {
  readonly causes: readonly unknown[];

  constructor(message: string, causes: readonly unknown[]) {
    super(message);
    this.name = 'WorktreeSymlinkSafetyError';
    this.causes = causes;
  }
}

interface WorktreeSymlinkDiscovery extends WorktreeSymlinkCandidatesResult {
  ignoreCase: boolean;
}

interface PlannedWorktreeSymlink {
  actualName: string;
  ignoreCase: boolean;
  isClaude: boolean;
  kind: 'directory' | 'file';
  requestName: string;
  sourcePath: string;
  targetPath: string;
}

interface WorktreeSymlinkIdentity {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
}

interface CreatedWorktreeSymlink extends PlannedWorktreeSymlink {
  targetIdentity: WorktreeSymlinkIdentity;
}

type ExcludeRuleDurability = 'already-present-and-durable' | 'appended-and-durable' | 'not-ensured';

function getUtf8Bytes(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function getExactByteKey(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function badWorktreeLinkRequest(message: string): BadRequestError {
  return new BadRequestError(`Invalid worktree link request: ${message}`);
}

function rejectInvalidCanonicalRequest(): never {
  throw new BadRequestError('Invalid canonical TaskWorktreeLinkRequestV1');
}

/**
 * Canonicalizes an untrusted task-worktree link hint before any task workflow side effect.
 * V1 is deliberately byte-defined so every runtime fingerprints and reserves from the same fact.
 */
export function encodeTaskWorktreeLinkRequestV1(
  rawNames: readonly string[],
): TaskWorktreeLinkRequestV1 {
  if (!Array.isArray(rawNames)) {
    throw badWorktreeLinkRequest('symlinkDirs must be an array');
  }
  if (rawNames.length > MAX_WORKTREE_SYMLINK_REQUEST_NAMES) {
    throw badWorktreeLinkRequest(
      `symlinkDirs must contain at most ${MAX_WORKTREE_SYMLINK_REQUEST_NAMES} entries`,
    );
  }

  const uniqueByBytes = new Map<string, { bytes: Buffer; name: string }>();
  for (const value of rawNames) {
    if (typeof value !== 'string') {
      throw badWorktreeLinkRequest('every symlinkDirs entry must be a string');
    }
    if (!isWellFormedUnicodeScalarString(value)) {
      throw badWorktreeLinkRequest('every symlinkDirs entry must contain valid Unicode scalars');
    }
    const bytes = getUtf8Bytes(value);
    if (bytes.length < 1 || bytes.length > MAX_WORKTREE_SYMLINK_NAME_BYTES) {
      throw badWorktreeLinkRequest(
        `every symlinkDirs entry must encode to 1..${MAX_WORKTREE_SYMLINK_NAME_BYTES} UTF-8 bytes`,
      );
    }
    const key = getExactByteKey(bytes);
    if (!uniqueByBytes.has(key)) {
      uniqueByBytes.set(key, { bytes, name: value });
    }
  }

  const entries = [...uniqueByBytes.values()].sort((left, right) =>
    Buffer.compare(left.bytes, right.bytes),
  );
  let encodedLength = 2;
  for (const entry of entries) {
    encodedLength += 2 + entry.bytes.length;
    if (encodedLength > MAX_WORKTREE_SYMLINK_REQUEST_BYTES) {
      throw badWorktreeLinkRequest(
        `canonical V1 encoding must be at most ${MAX_WORKTREE_SYMLINK_REQUEST_BYTES} bytes`,
      );
    }
  }

  const encodedBytes = new Uint8Array(encodedLength);
  encodedBytes[0] = 0x01;
  encodedBytes[1] = entries.length;
  let offset = 2;
  for (const entry of entries) {
    encodedBytes[offset] = entry.bytes.length >>> 8;
    encodedBytes[offset + 1] = entry.bytes.length & 0xff;
    offset += 2;
    encodedBytes.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }

  return Object.freeze({
    [TASK_WORKTREE_LINK_REQUEST_V1]: true as const,
    encodedBytes,
    encodedLength,
    format: 1 as const,
    names: Object.freeze(entries.map((entry) => entry.name)),
  });
}

/**
 * Proves that an internal request still contains the exact owner-created V1 representation.
 * This is intentionally a decoder/equality check, not a second canonical encoder.
 */
export function assertTaskWorktreeLinkRequestV1(
  request: unknown,
): asserts request is TaskWorktreeLinkRequestV1 {
  if (!request || typeof request !== 'object') {
    rejectInvalidCanonicalRequest();
  }

  const candidate = request as Partial<TaskWorktreeLinkRequestV1>;
  const names = candidate.names;
  const encodedBytes = candidate.encodedBytes;
  const encodedLength = candidate.encodedLength;
  if (
    candidate[TASK_WORKTREE_LINK_REQUEST_V1] !== true ||
    candidate.format !== 1 ||
    !Array.isArray(names) ||
    !(encodedBytes instanceof Uint8Array) ||
    !Number.isSafeInteger(encodedLength) ||
    encodedLength !== encodedBytes.byteLength ||
    encodedLength < 2 ||
    encodedLength > MAX_WORKTREE_SYMLINK_REQUEST_BYTES ||
    names.length > MAX_WORKTREE_SYMLINK_REQUEST_NAMES ||
    encodedBytes[0] !== 0x01 ||
    encodedBytes[1] !== names.length
  ) {
    rejectInvalidCanonicalRequest();
  }

  let offset = 2;
  let previousBytes: Buffer | null = null;
  for (const name of names) {
    if (
      typeof name !== 'string' ||
      !isWellFormedUnicodeScalarString(name) ||
      offset + 2 > encodedLength
    ) {
      rejectInvalidCanonicalRequest();
    }
    const nameLength = (encodedBytes[offset] ?? 0) * 0x100 + (encodedBytes[offset + 1] ?? 0);
    offset += 2;
    if (
      nameLength < 1 ||
      nameLength > MAX_WORKTREE_SYMLINK_NAME_BYTES ||
      offset + nameLength > encodedLength
    ) {
      rejectInvalidCanonicalRequest();
    }

    const encodedName = Buffer.from(
      encodedBytes.buffer,
      encodedBytes.byteOffset + offset,
      nameLength,
    );
    const expectedName = getUtf8Bytes(name);
    if (
      expectedName.length !== nameLength ||
      !expectedName.equals(encodedName) ||
      (previousBytes !== null && Buffer.compare(previousBytes, encodedName) >= 0)
    ) {
      rejectInvalidCanonicalRequest();
    }
    previousBytes = encodedName;
    offset += nameLength;
  }

  if (offset !== encodedLength) {
    rejectInvalidCanonicalRequest();
  }
}

export function isValidWorktreeSymlinkName(name: unknown): name is string {
  if (typeof name !== 'string') {
    return false;
  }
  const byteLength = Buffer.byteLength(name, 'utf8');
  return (
    byteLength >= 1 &&
    byteLength <= MAX_WORKTREE_SYMLINK_NAME_BYTES &&
    isWellFormedUnicodeScalarString(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes('\r') &&
    !name.includes('\n')
  );
}

function foldWorktreeSymlinkName(name: string, ignoreCase: boolean): string {
  return ignoreCase ? name.toLowerCase() : name;
}

export function isReservedWorktreeSymlinkName(name: string, ignoreCase: boolean): boolean {
  const key = foldWorktreeSymlinkName(name, ignoreCase);
  return RESERVED_WORKTREE_SYMLINK_NAMES.some(
    (reservedName) => foldWorktreeSymlinkName(reservedName, ignoreCase) === key,
  );
}

function isDefaultWorktreeSymlinkName(name: string, ignoreCase: boolean): boolean {
  const key = foldWorktreeSymlinkName(name, ignoreCase);
  return DEFAULT_WORKTREE_SYMLINK_NAMES.some(
    (defaultName) => foldWorktreeSymlinkName(defaultName, ignoreCase) === key,
  );
}

function isClaudeLocalEntryName(name: string, ignoreCase: boolean): boolean {
  const key = foldWorktreeSymlinkName(name, ignoreCase);
  for (const excludedName of CLAUDE_DIR_EXCLUDE) {
    if (foldWorktreeSymlinkName(excludedName, ignoreCase) === key) {
      return true;
    }
  }
  return false;
}

export function escapeWorktreeSymlinkNameForGitExclude(name: string): string {
  if (!isValidWorktreeSymlinkName(name)) {
    throw new BadRequestError('Cannot encode an invalid worktree link name as a Git exclude rule');
  }

  const trailingSpaces = / +$/u.exec(name)?.[0].length ?? 0;
  const bodyEnd = name.length - trailingSpaces;
  let escaped = '';
  for (let index = 0; index < bodyEnd; index += 1) {
    const character = name[index] ?? '';
    if (
      character === '\\' ||
      character === '*' ||
      character === '?' ||
      character === '[' ||
      character === ']' ||
      (index === 0 && (character === '#' || character === '!'))
    ) {
      escaped += '\\';
    }
    escaped += character;
  }
  escaped += '\\ '.repeat(trailingSpaces);
  return `/${escaped}`;
}

function normalizeGitExcludeLineBytes(line: Buffer): Buffer {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0d) {
    end -= 1;
  }

  while (end > 0 && line[end - 1] === 0x20) {
    let backslashCount = 0;
    for (let index = end - 2; index >= 0 && line[index] === 0x5c; index -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 1) {
      break;
    }
    end -= 1;
  }
  return line.subarray(0, end);
}

export function normalizeGitExcludeLine(line: string): string {
  return normalizeGitExcludeLineBytes(Buffer.from(line, 'utf8')).toString('utf8');
}

function splitNulOutput(output: Buffer): string[] {
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== 0x00) {
      continue;
    }
    if (index === output.length && start === output.length) {
      break;
    }
    const bytes = output.subarray(start, index);
    const value = bytes.toString('utf8');
    if (Buffer.from(value, 'utf8').equals(bytes)) {
      entries.push(value);
    }
    start = index + 1;
  }
  return entries;
}

function parseIgnoreCase(stdout: string): boolean {
  return stdout.trim().toLowerCase() === 'true';
}

function parseWorktreeSymlinkCandidates(
  output: Buffer,
  ignoreCase: boolean,
): WorktreeSymlinkDiscovery {
  const candidateByPolicyKey = new Map<string, WorktreeSymlinkCandidate & { bytes: Buffer }>();
  for (const entry of splitNulOutput(output)) {
    const name = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (!isValidWorktreeSymlinkName(name) || isReservedWorktreeSymlinkName(name, ignoreCase)) {
      continue;
    }
    const bytes = getUtf8Bytes(name);
    const key = ignoreCase ? foldWorktreeSymlinkName(name, true) : getExactByteKey(bytes);
    const existing = candidateByPolicyKey.get(key);
    if (existing && Buffer.compare(existing.bytes, bytes) <= 0) {
      continue;
    }
    candidateByPolicyKey.set(key, {
      bytes,
      isDefault: isDefaultWorktreeSymlinkName(name, ignoreCase),
      name,
    });
  }

  const candidates = [...candidateByPolicyKey.values()];
  candidates.sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return Buffer.compare(left.bytes, right.bytes);
  });

  return {
    candidates: candidates
      .slice(0, MAX_WORKTREE_SYMLINK_REQUEST_NAMES)
      .map(({ isDefault, name }) => ({ isDefault, name })),
    ignoreCase,
    truncated: candidates.length > MAX_WORKTREE_SYMLINK_REQUEST_NAMES,
  };
}

async function discoverWorktreeSymlinkCandidates(
  projectRoot: string,
): Promise<WorktreeSymlinkDiscovery> {
  const ignoreCasePromise = execGit(['config', '--bool', '--get', 'core.ignorecase'], {
    cwd: projectRoot,
    maxBuffer: WORKTREE_SYMLINK_MAX_OUTPUT_BYTES,
    timeout: WORKTREE_SYMLINK_GIT_TIMEOUT_MS,
  }).then(
    ({ stdout }) => parseIgnoreCase(stdout),
    () => false,
  );
  const candidatesPromise = execGitBuffer(
    [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--',
      ':(top,glob)*',
      ':(top,glob).*',
    ],
    {
      cwd: projectRoot,
      maxBuffer: WORKTREE_SYMLINK_MAX_OUTPUT_BYTES,
      timeout: WORKTREE_SYMLINK_GIT_TIMEOUT_MS,
    },
  );
  const [ignoreCase, { stdout }] = await Promise.all([ignoreCasePromise, candidatesPromise]);
  return parseWorktreeSymlinkCandidates(stdout, ignoreCase);
}

export async function getWorktreeSymlinkCandidates(
  projectRoot: string,
): Promise<WorktreeSymlinkCandidatesResult> {
  const { candidates, truncated } = await discoverWorktreeSymlinkCandidates(projectRoot);
  return { candidates, truncated };
}

/** Keeps the existing string-array renderer contract on curated defaults until its UI slice lands. */
export async function getDefaultWorktreeSymlinkCandidateNames(
  projectRoot: string,
): Promise<string[]> {
  const { candidates } = await discoverWorktreeSymlinkCandidates(projectRoot);
  return candidates.filter((candidate) => candidate.isDefault).map((candidate) => candidate.name);
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function lstatOrNull(candidatePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(candidatePath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function lstatBigIntOrNull(candidatePath: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(candidatePath, { bigint: true });
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function createWarning(name: string, reason: WorktreeSymlinkWarningReason): WorktreeSymlinkWarning {
  const renderedName = JSON.stringify(name);
  return {
    message: `Could not share ${renderedName}: ${WORKTREE_SYMLINK_WARNING_DETAILS[reason]}.`,
    name,
    reason,
  };
}

async function inspectPlannedWorktreeSymlink(
  projectRoot: string,
  worktreePath: string,
  requestName: string,
  actualName: string,
  ignoreCase: boolean,
  isClaude: boolean,
): Promise<PlannedWorktreeSymlink | WorktreeSymlinkWarning> {
  const sourcePath = path.join(projectRoot, actualName);
  const targetPath = path.join(worktreePath, actualName);
  let source: fs.Stats | null;
  let target: fs.Stats | null;
  try {
    [source, target] = await Promise.all([lstatOrNull(sourcePath), lstatOrNull(targetPath)]);
  } catch {
    return createWarning(requestName, 'link_failed');
  }
  if (!source) {
    return createWarning(requestName, 'source_missing');
  }
  if (source.isSymbolicLink()) {
    return createWarning(requestName, 'source_symlink');
  }
  const kind = source.isDirectory() ? 'directory' : source.isFile() ? 'file' : null;
  if (!kind || (isClaude && kind !== 'directory')) {
    return createWarning(requestName, 'unsupported_source_kind');
  }
  if (target) {
    return createWarning(requestName, 'destination_exists');
  }
  return {
    actualName,
    ignoreCase,
    isClaude,
    kind,
    requestName,
    sourcePath,
    targetPath,
  };
}

function splitExcludeLines(content: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === 0x0a) {
      lines.push(content.subarray(start, index));
      start = index + 1;
    }
  }
  return lines;
}

function getDirectoryNoFollowFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
}

async function assertDirectoryHandleOwnsPath(
  handle: fs.promises.FileHandle,
  directoryPath: string,
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    lstatBigIntOrNull(directoryPath),
  ]);
  if (
    !handleStat.isDirectory() ||
    !pathStat?.isDirectory() ||
    pathStat.isSymbolicLink() ||
    pathStat.dev !== handleStat.dev ||
    pathStat.ino !== handleStat.ino
  ) {
    throw new Error('Git common info path is not a stable real directory');
  }
}

async function openVerifiedDirectory(directoryPath: string): Promise<fs.promises.FileHandle> {
  const handle = await fs.promises.open(directoryPath, getDirectoryNoFollowFlags());
  try {
    await assertDirectoryHandleOwnsPath(handle, directoryPath);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function getAppendNoFollowFlags(): number {
  return (
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    fs.constants.O_RDWR |
    (fs.constants.O_NOFOLLOW ?? 0)
  );
}

async function readOpenedFileFromStart(
  handle: fs.promises.FileHandle,
  byteLength: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Git common info/exclude has an invalid size');
  }
  const content = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === content.length ? content : content.subarray(0, offset);
}

async function ensureCommonExcludeRulesLocked(
  commonDirectory: string,
  names: readonly string[],
): Promise<Map<string, ExcludeRuleDurability>> {
  const results = new Map<string, ExcludeRuleDurability>(
    names.map((name) => [name, 'not-ensured']),
  );
  const infoDirectory = path.join(commonDirectory, 'info');
  const excludePath = path.join(infoDirectory, 'exclude');
  await fs.promises.mkdir(infoDirectory, { recursive: true });

  // Keep the exact real parent directory open for the whole transaction. O_NOFOLLOW
  // rejects a pre-existing symlink, while the identity checks prevent a replaced
  // path from being accepted before the exclude file is read or changed.
  const infoDirectoryHandle = await openVerifiedDirectory(infoDirectory);
  let directoryOperationError: unknown;
  try {
    await assertDirectoryHandleOwnsPath(infoDirectoryHandle, infoDirectory);

    const existingStat = await lstatOrNull(excludePath);
    if (existingStat?.isSymbolicLink() || (existingStat && !existingStat.isFile())) {
      throw new Error('Git common info/exclude is not a regular file');
    }
    const fileWasCreated = existingStat === null;
    const handle = await fs.promises.open(excludePath, getAppendNoFollowFlags(), 0o666);
    let operationError: unknown;
    let appendedNames = new Set<string>();
    try {
      await assertDirectoryHandleOwnsPath(infoDirectoryHandle, infoDirectory);
      const handleStat = await handle.stat();
      const openedPathStat = await fs.promises.lstat(excludePath);
      if (
        !handleStat.isFile() ||
        openedPathStat.isSymbolicLink() ||
        !openedPathStat.isFile() ||
        openedPathStat.dev !== handleStat.dev ||
        openedPathStat.ino !== handleStat.ino
      ) {
        throw new Error('Git common info/exclude is not a regular file');
      }
      const content = await readOpenedFileFromStart(handle, handleStat.size);
      const existingLines = new Set(
        splitExcludeLines(content).map((line) =>
          getExactByteKey(normalizeGitExcludeLineBytes(line)),
        ),
      );
      const missingRules = names.filter((name) => {
        const rule = Buffer.from(escapeWorktreeSymlinkNameForGitExclude(name), 'utf8');
        return !existingLines.has(getExactByteKey(rule));
      });

      if (missingRules.length > 0) {
        const headerKey = getExactByteKey(Buffer.from(EXCLUDE_HEADER, 'utf8'));
        const linesToAppend = [
          ...(existingLines.has(headerKey) ? [] : [EXCLUDE_HEADER]),
          ...missingRules.map(escapeWorktreeSymlinkNameForGitExclude),
        ];
        const newline = content.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
        const prefix = content.length > 0 && content[content.length - 1] !== 0x0a ? newline : '';
        const appendBuffer = Buffer.from(
          `${prefix}${linesToAppend.join(newline)}${newline}`,
          'utf8',
        );
        const { bytesWritten } = await handle.write(appendBuffer, 0, appendBuffer.length, null);
        if (bytesWritten !== appendBuffer.length) {
          throw new Error('Git common info/exclude append was incomplete');
        }
        appendedNames = new Set(missingRules);
      }
      await handle.sync();
    } catch (error) {
      operationError = error;
    }
    try {
      await handle.close();
    } catch (error) {
      operationError ??= error;
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (fileWasCreated) {
      await infoDirectoryHandle.sync();
    }

    for (const name of names) {
      results.set(
        name,
        appendedNames.has(name) ? 'appended-and-durable' : 'already-present-and-durable',
      );
    }
  } catch (error) {
    directoryOperationError = error;
  }
  try {
    await infoDirectoryHandle.close();
  } catch (error) {
    directoryOperationError ??= error;
  }
  if (directoryOperationError !== undefined) throw directoryOperationError;
  return results;
}

async function resolveGitCommonDirectory(projectRoot: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: projectRoot,
    maxBuffer: WORKTREE_SYMLINK_MAX_OUTPUT_BYTES,
    timeout: WORKTREE_SYMLINK_GIT_TIMEOUT_MS,
  });
  const commonDirectory = stdout.replace(/\r?\n$/u, '');
  if (
    commonDirectory.length === 0 ||
    !path.isAbsolute(commonDirectory) ||
    commonDirectory.includes('\0') ||
    commonDirectory.includes('\r') ||
    commonDirectory.includes('\n')
  ) {
    throw new Error('Git returned an invalid common directory');
  }
  return path.resolve(commonDirectory);
}

async function ensureCommonExcludeRules(
  commonDirectory: string,
  names: readonly string[],
): Promise<Map<string, ExcludeRuleDurability>> {
  return withWorktreeLock(`git-info-exclude:${commonDirectory}`, () =>
    ensureCommonExcludeRulesLocked(commonDirectory, names),
  );
}

function getSymlinkType(kind: PlannedWorktreeSymlink['kind']): 'file' | 'junction' | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  return kind === 'directory' ? 'junction' : 'file';
}

function normalizeLinkPathForComparison(candidatePath: string): string {
  let portablePath = candidatePath;
  if (process.platform === 'win32') {
    if (portablePath.startsWith('\\\\?\\UNC\\')) {
      portablePath = `\\\\${portablePath.slice(8)}`;
    } else if (portablePath.startsWith('\\\\?\\') || portablePath.startsWith('\\??\\')) {
      portablePath = portablePath.slice(4);
    }
  }
  const resolved = path.resolve(portablePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function linkResolvesToPlannedSource(
  linkTarget: string,
  targetPath: string,
  sourcePath: string,
): boolean {
  return (
    normalizeLinkPathForComparison(path.resolve(path.dirname(targetPath), linkTarget)) ===
    normalizeLinkPathForComparison(sourcePath)
  );
}

function captureSymlinkIdentity(target: fs.BigIntStats): WorktreeSymlinkIdentity {
  return {
    birthtimeNs: target.birthtimeNs,
    ctimeNs: target.ctimeNs,
    dev: target.dev,
    ino: target.ino,
    mode: target.mode,
    mtimeNs: target.mtimeNs,
  };
}

function symlinkIdentityMatches(
  expected: WorktreeSymlinkIdentity,
  target: fs.BigIntStats,
): boolean {
  return (
    target.birthtimeNs === expected.birthtimeNs &&
    target.ctimeNs === expected.ctimeNs &&
    target.dev === expected.dev &&
    target.ino === expected.ino &&
    target.mode === expected.mode &&
    target.mtimeNs === expected.mtimeNs
  );
}

async function inspectCreatedLink(
  plan: PlannedWorktreeSymlink,
): Promise<{ created: CreatedWorktreeSymlink; resolvesToSource: boolean }> {
  const target = await fs.promises.lstat(plan.targetPath, { bigint: true });
  if (!target.isSymbolicLink()) {
    throw new Error('Created worktree target is not a symbolic link');
  }
  const created = { ...plan, targetIdentity: captureSymlinkIdentity(target) };
  const linkTarget = await fs.promises.readlink(plan.targetPath);
  return {
    created,
    resolvesToSource: linkResolvesToPlannedSource(linkTarget, plan.targetPath, plan.sourcePath),
  };
}

async function removeCreatedLinkAndVerifyAbsence(plan: CreatedWorktreeSymlink): Promise<void> {
  const target = await lstatBigIntOrNull(plan.targetPath);
  if (!target) {
    return;
  }
  if (!target.isSymbolicLink() || !symlinkIdentityMatches(plan.targetIdentity, target)) {
    throw new Error('Refusing to remove a worktree target that is no longer the created link');
  }
  const linkTarget = await fs.promises.readlink(plan.targetPath);
  if (!linkResolvesToPlannedSource(linkTarget, plan.targetPath, plan.sourcePath)) {
    throw new Error('Refusing to remove a worktree link whose target changed unexpectedly');
  }
  const confirmedTarget = await lstatBigIntOrNull(plan.targetPath);
  if (!confirmedTarget) {
    return;
  }
  if (
    !confirmedTarget.isSymbolicLink() ||
    !symlinkIdentityMatches(plan.targetIdentity, confirmedTarget)
  ) {
    throw new Error('Refusing to remove a worktree target that changed before cleanup');
  }
  await fs.promises.unlink(plan.targetPath);
  if ((await lstatOrNull(plan.targetPath)) !== null) {
    throw new Error('Could not prove removal of an unsafe worktree link');
  }
}

async function createGenericWorktreeSymlink(
  plan: PlannedWorktreeSymlink,
): Promise<CreatedWorktreeSymlink | WorktreeSymlinkWarning> {
  const refreshed = await inspectPlannedWorktreeSymlink(
    path.dirname(plan.sourcePath),
    path.dirname(plan.targetPath),
    plan.requestName,
    plan.actualName,
    plan.ignoreCase,
    plan.isClaude,
  );
  if ('reason' in refreshed) {
    return refreshed;
  }
  try {
    await fs.promises.symlink(
      refreshed.sourcePath,
      refreshed.targetPath,
      getSymlinkType(refreshed.kind),
    );
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      return createWarning(plan.requestName, 'destination_exists');
    }
    const unexpectedTarget = await lstatOrNull(refreshed.targetPath);
    if (unexpectedTarget) {
      throw new WorktreeSymlinkSafetyError(
        'Link creation failed after a target appeared unexpectedly',
        [error],
      );
    }
    return createWarning(plan.requestName, 'link_failed');
  }

  try {
    const inspection = await inspectCreatedLink(refreshed);
    if (!inspection.resolvesToSource) {
      await removeCreatedLinkAndVerifyAbsence(inspection.created);
      return createWarning(plan.requestName, 'link_failed');
    }
    return inspection.created;
  } catch (error) {
    if ((await lstatOrNull(refreshed.targetPath)) !== null) {
      throw new WorktreeSymlinkSafetyError(
        'Could not safely verify a newly created worktree link',
        [error],
      );
    }
    return createWarning(plan.requestName, 'link_failed');
  }
}

async function removeClaudeTargetAndVerifyAbsence(
  plan: PlannedWorktreeSymlink,
  linkedEntries: readonly CreatedWorktreeSymlink[],
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  for (const entry of [...linkedEntries].reverse()) {
    try {
      await removeCreatedLinkAndVerifyAbsence(entry);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  try {
    const target = await lstatOrNull(plan.targetPath);
    if (target !== null) {
      if (!target.isDirectory() || target.isSymbolicLink()) {
        throw new Error('Incomplete .claude target is no longer the created directory');
      }
      await fs.promises.rmdir(plan.targetPath);
    }
    if ((await lstatOrNull(plan.targetPath)) !== null) {
      throw new Error('Could not prove removal of an incomplete .claude worktree target');
    }
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (cleanupFailures.length > 0) {
    throw new WorktreeSymlinkSafetyError(
      'Could not safely remove an incomplete .claude worktree target',
      cleanupFailures,
    );
  }
}

async function applyClaudeShallowLinks(
  plan: PlannedWorktreeSymlink,
): Promise<WorktreeSymlinkWarning | null> {
  const refreshed = await inspectPlannedWorktreeSymlink(
    path.dirname(plan.sourcePath),
    path.dirname(plan.targetPath),
    plan.requestName,
    plan.actualName,
    plan.ignoreCase,
    plan.isClaude,
  );
  if ('reason' in refreshed) {
    return refreshed;
  }

  let targetCreated = false;
  const linkedEntries: CreatedWorktreeSymlink[] = [];
  try {
    await fs.promises.mkdir(refreshed.targetPath);
    targetCreated = true;
    const entries = await fs.promises.readdir(refreshed.sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (isClaudeLocalEntryName(entry.name, refreshed.ignoreCase)) {
        continue;
      }
      const sourcePath = path.join(refreshed.sourcePath, entry.name);
      const targetPath = path.join(refreshed.targetPath, entry.name);
      await fs.promises.symlink(
        sourcePath,
        targetPath,
        getSymlinkType(entry.isDirectory() ? 'directory' : 'file'),
      );
      const inspection = await inspectCreatedLink({
        ...refreshed,
        sourcePath,
        targetPath,
      });
      if (!inspection.resolvesToSource) {
        await removeCreatedLinkAndVerifyAbsence(inspection.created);
        throw new Error('A .claude shallow link failed verification');
      }
      linkedEntries.push(inspection.created);
    }

    const target = await fs.promises.lstat(refreshed.targetPath);
    if (!target.isDirectory() || target.isSymbolicLink()) {
      throw new Error('.claude worktree target is not a real directory');
    }
    for (const excludedName of CLAUDE_DIR_EXCLUDE) {
      if ((await lstatOrNull(path.join(refreshed.targetPath, excludedName))) !== null) {
        throw new Error(`Excluded .claude entry ${excludedName} appeared in the worktree target`);
      }
    }
    return null;
  } catch (error) {
    if (!targetCreated) {
      return createWarning(
        plan.requestName,
        getErrorCode(error) === 'EEXIST' ? 'destination_exists' : 'link_failed',
      );
    }
    await removeClaudeTargetAndVerifyAbsence(refreshed, linkedEntries);
    return createWarning(plan.requestName, 'link_failed');
  }
}

function readCheckIgnoreOutput(error: unknown): Buffer | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  if (Number((error as { code?: unknown }).code) !== 1) {
    return null;
  }
  const stdout = (error as { stdout?: unknown }).stdout;
  if (Buffer.isBuffer(stdout)) {
    return stdout;
  }
  return typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : Buffer.alloc(0);
}

async function checkCreatedLinksAreIgnored(
  worktreePath: string,
  created: readonly CreatedWorktreeSymlink[],
): Promise<Set<string>> {
  const input = Buffer.concat(created.map((entry) => Buffer.from(`${entry.actualName}\0`, 'utf8')));
  try {
    const { stdout } = await execGitBuffer(['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: worktreePath,
      input,
      maxBuffer: WORKTREE_SYMLINK_MAX_OUTPUT_BYTES,
      timeout: WORKTREE_SYMLINK_GIT_TIMEOUT_MS,
    });
    return new Set(splitNulOutput(stdout));
  } catch (error) {
    const stdout = readCheckIgnoreOutput(error);
    if (stdout !== null) {
      return new Set(splitNulOutput(stdout));
    }
    throw error;
  }
}

async function removeUnprovedLinks(
  created: readonly CreatedWorktreeSymlink[],
  ignoredNames: ReadonlySet<string> | null,
): Promise<CreatedWorktreeSymlink[]> {
  const removed: CreatedWorktreeSymlink[] = [];
  const cleanupFailures: unknown[] = [];
  for (const entry of created) {
    if (ignoredNames?.has(entry.actualName)) {
      continue;
    }
    try {
      await removeCreatedLinkAndVerifyAbsence(entry);
      removed.push(entry);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new WorktreeSymlinkSafetyError(
      'Could not safely remove unproved worktree links',
      cleanupFailures,
    );
  }
  return removed;
}

function getPolicyUniqueRequestNames(
  names: readonly string[],
  ignoreCase: boolean,
): readonly string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = ignoreCase
      ? foldWorktreeSymlinkName(name, true)
      : getExactByteKey(getUtf8Bytes(name));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function applyRequestedWorktreeSymlinks(
  projectRoot: string,
  worktreePath: string,
  request: TaskWorktreeLinkRequestV1,
): Promise<ApplyRequestedWorktreeSymlinksResult> {
  assertTaskWorktreeLinkRequestV1(request);
  if (request.names.length === 0) {
    return { warnings: [] };
  }

  let discovery: WorktreeSymlinkDiscovery;
  try {
    discovery = await discoverWorktreeSymlinkCandidates(projectRoot);
  } catch {
    return {
      warnings: request.names.map((name) => createWarning(name, 'candidate_query_failed')),
    };
  }

  const requestNames = getPolicyUniqueRequestNames(request.names, discovery.ignoreCase);
  const currentCandidateByKey = new Map(
    discovery.candidates.map((candidate) => [
      foldWorktreeSymlinkName(candidate.name, discovery.ignoreCase),
      candidate,
    ]),
  );
  const warningByRequestName = new Map<string, WorktreeSymlinkWarning>();
  const plans: PlannedWorktreeSymlink[] = [];
  for (const requestName of requestNames) {
    if (!isValidWorktreeSymlinkName(requestName)) {
      warningByRequestName.set(requestName, createWarning(requestName, 'invalid_name'));
      continue;
    }
    if (isReservedWorktreeSymlinkName(requestName, discovery.ignoreCase)) {
      warningByRequestName.set(requestName, createWarning(requestName, 'reserved_name'));
      continue;
    }
    const candidate = currentCandidateByKey.get(
      foldWorktreeSymlinkName(requestName, discovery.ignoreCase),
    );
    if (!candidate) {
      warningByRequestName.set(requestName, createWarning(requestName, 'not_current_candidate'));
      continue;
    }
    const planned = await inspectPlannedWorktreeSymlink(
      projectRoot,
      worktreePath,
      requestName,
      candidate.name,
      discovery.ignoreCase,
      foldWorktreeSymlinkName(candidate.name, discovery.ignoreCase) === '.claude',
    );
    if ('reason' in planned) {
      warningByRequestName.set(requestName, planned);
      continue;
    }
    plans.push(planned);
  }

  const genericPlans = plans.filter((plan) => !plan.isClaude);
  let excludeResults = new Map<string, ExcludeRuleDurability>();
  if (genericPlans.length > 0) {
    try {
      const commonDirectory = await resolveGitCommonDirectory(projectRoot);
      excludeResults = await ensureCommonExcludeRules(
        commonDirectory,
        genericPlans.map((plan) => plan.actualName),
      );
    } catch {
      for (const plan of genericPlans) {
        warningByRequestName.set(
          plan.requestName,
          createWarning(plan.requestName, 'exclude_update_failed'),
        );
      }
    }
  }

  const createdGenericLinks: CreatedWorktreeSymlink[] = [];
  for (const plan of plans) {
    if (plan.isClaude) {
      const warning = await applyClaudeShallowLinks(plan);
      if (warning) {
        warningByRequestName.set(plan.requestName, warning);
      }
      continue;
    }
    if (
      excludeResults.get(plan.actualName) === 'not-ensured' ||
      !excludeResults.has(plan.actualName)
    ) {
      warningByRequestName.set(
        plan.requestName,
        createWarning(plan.requestName, 'exclude_update_failed'),
      );
      continue;
    }
    const created = await createGenericWorktreeSymlink(plan);
    if ('reason' in created) {
      warningByRequestName.set(plan.requestName, created);
    } else {
      createdGenericLinks.push(created);
    }
  }

  if (createdGenericLinks.length > 0) {
    let ignoredNames: Set<string> | null = null;
    try {
      ignoredNames = await checkCreatedLinksAreIgnored(worktreePath, createdGenericLinks);
    } catch {
      // The cleanup below is mandatory before the otherwise-valid task may continue.
    }
    const removed = await removeUnprovedLinks(createdGenericLinks, ignoredNames);
    for (const entry of removed) {
      warningByRequestName.set(
        entry.requestName,
        createWarning(entry.requestName, 'ignore_postcondition_failed'),
      );
    }
  }

  return {
    warnings: requestNames.flatMap((name) => {
      const warning = warningByRequestName.get(name);
      return warning ? [warning] : [];
    }),
  };
}
