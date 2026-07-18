import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execFileWithDeadline } from './bounded-process.js';
const PATH_LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which';
const POSIX_WHEREIS_COMMAND = 'whereis';
const LOGIN_SHELL = process.platform === 'win32' ? null : process.env.SHELL || '/bin/bash';
const COMMAND_LOOKUP_TIMEOUT_MS = 3000;
const LOGIN_SHELL_RESOLVED_PATH_PREFIX = '__PARALLEL_CODE_RESOLVED_COMMAND__=';
const resolvedCommandCache = new Map<string, string>();

function getPathEntries(rawPath = process.env.PATH ?? ''): string[] {
  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function prependPathEntries(entries: Array<string | null | undefined>): void {
  const currentEntries = getPathEntries();
  const currentSet = new Set(currentEntries);
  const additions: string[] = [];

  for (const entry of entries) {
    if (!entry || currentSet.has(entry) || additions.includes(entry)) continue;
    additions.push(entry);
  }

  if (additions.length === 0) return;
  process.env.PATH = [...additions, ...currentEntries].join(path.delimiter);
}

function isNodeVersionDirName(name: string): boolean {
  return /^v?\d+(?:\.\d+){0,2}$/.test(name);
}

function getExistingNodeVersionDirs(
  versionsDir: string,
  getBinDir: (entryName: string) => string,
): string[] {
  try {
    return fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isNodeVersionDirName(entry.name))
      .map((entry) => getBinDir(entry.name))
      .filter((entry) => fs.existsSync(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function getExistingNvmNodeBinDirs(nvmDir: string | undefined): string[] {
  if (!nvmDir) {
    return [];
  }

  return [
    ...getExistingNodeVersionDirs(path.join(nvmDir, 'versions', 'node'), (entryName) =>
      path.join(nvmDir, 'versions', 'node', entryName, 'bin'),
    ),
    ...getExistingNodeVersionDirs(nvmDir, (entryName) => path.join(nvmDir, entryName)),
  ];
}

function getHomeDirectory(): string {
  try {
    return os.homedir() || process.env.HOME || process.env.USERPROFILE || '';
  } catch {
    return process.env.HOME || process.env.USERPROFILE || '';
  }
}

function getDefaultPathExpansionDirs(): string[] {
  const home = getHomeDirectory();
  const dirs: string[] = [];

  if (process.env.PNPM_HOME) {
    dirs.push(process.env.PNPM_HOME);
  }
  if (process.env.VOLTA_HOME) {
    dirs.push(path.join(process.env.VOLTA_HOME, 'bin'));
  }
  if (process.env.NVM_DIR) {
    dirs.push(...getExistingNvmNodeBinDirs(process.env.NVM_DIR));
  }
  if (process.env.NVM_HOME) {
    dirs.push(...getExistingNvmNodeBinDirs(process.env.NVM_HOME));
  }
  if (process.env.NVM_SYMLINK) {
    dirs.push(process.env.NVM_SYMLINK);
  }

  if (home) {
    dirs.push(
      ...getExistingNvmNodeBinDirs(path.join(home, '.nvm')),
      path.join(home, '.local', 'bin'),
      path.join(home, '.local', 'share', 'pnpm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.volta', 'bin'),
    );
  }

  dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  return dirs;
}

// Server and Electron processes may not inherit the same PATH as the user's interactive shell.
prependPathEntries(getDefaultPathExpansionDirs());

function ensureDefaultPathExpansion(): void {
  prependPathEntries(getDefaultPathExpansionDirs());
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getLoginShellCommandLookupScript(command: string): string {
  return `command -v -- ${quoteForShell(command)} | sed ${quoteForShell(
    `s/^/${LOGIN_SHELL_RESOLVED_PATH_PREFIX}/`,
  )}`;
}

function getLoginShellResolvedPath(output: string): string | null {
  const resolvedLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(LOGIN_SHELL_RESOLVED_PATH_PREFIX));
  const resolvedPath = resolvedLine?.slice(LOGIN_SHELL_RESOLVED_PATH_PREFIX.length).trim();
  if (!resolvedPath || !path.isAbsolute(resolvedPath) || !isExecutable(resolvedPath)) {
    return null;
  }
  return resolvedPath;
}

function getWhereisCommandPath(output: string, command: string): string | null {
  const [, rest = ''] = output.split(/:(.*)/s);
  const candidates = rest
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const candidate of candidates) {
    const basename = path.basename(candidate);
    if (basename !== command && basename !== `${command}.exe`) {
      continue;
    }
    if (path.isAbsolute(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutable(command: string): boolean {
  try {
    fs.accessSync(command, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cacheResolvedCommand(command: string, resolvedPath: string | null): string | null {
  if (!resolvedPath) {
    resolvedCommandCache.delete(command);
    return null;
  }

  resolvedCommandCache.set(command, resolvedPath);
  if (path.isAbsolute(resolvedPath)) {
    prependPathEntries([path.dirname(resolvedPath)]);
  }
  return resolvedPath;
}

function canUsePosixBareCommandLookup(command: string): boolean {
  return process.platform !== 'win32' && !isAbsoluteCommandPath(command);
}

async function resolveCommandWithWhereis(command: string): Promise<string | null> {
  if (!canUsePosixBareCommandLookup(command)) {
    return null;
  }

  try {
    const { stdout } = await execFileWithDeadline(POSIX_WHEREIS_COMMAND, ['-b', command], {
      encoding: 'utf8',
      timeoutMs: COMMAND_LOOKUP_TIMEOUT_MS,
    });
    return cacheResolvedCommand(command, getWhereisCommandPath(stdout, command));
  } catch {
    return null;
  }
}

function resolveCommandWithWhereisSync(command: string): string | null {
  if (!canUsePosixBareCommandLookup(command)) {
    return null;
  }

  try {
    const stdout = execFileSync(POSIX_WHEREIS_COMMAND, ['-b', command], {
      encoding: 'utf8',
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cacheResolvedCommand(command, getWhereisCommandPath(stdout, command));
  } catch {
    return null;
  }
}

async function resolveCommandWithLoginShell(command: string): Promise<string | null> {
  if (!LOGIN_SHELL || !canUsePosixBareCommandLookup(command)) return null;
  if (resolvedCommandCache.has(command)) {
    return resolvedCommandCache.get(command) ?? null;
  }

  try {
    const { stdout } = await execFileWithDeadline(
      LOGIN_SHELL,
      ['-lc', getLoginShellCommandLookupScript(command)],
      {
        encoding: 'utf8',
        timeoutMs: COMMAND_LOOKUP_TIMEOUT_MS,
      },
    );
    return cacheResolvedCommand(command, getLoginShellResolvedPath(stdout));
  } catch {
    return cacheResolvedCommand(command, null);
  }
}

function resolveCommandWithLoginShellSync(command: string): string | null {
  if (!LOGIN_SHELL || !canUsePosixBareCommandLookup(command)) return null;
  if (resolvedCommandCache.has(command)) {
    return resolvedCommandCache.get(command) ?? null;
  }

  try {
    const stdout = execFileSync(LOGIN_SHELL, ['-lc', getLoginShellCommandLookupScript(command)], {
      encoding: 'utf8',
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cacheResolvedCommand(command, getLoginShellResolvedPath(stdout));
  } catch {
    return cacheResolvedCommand(command, null);
  }
}

function isAbsoluteCommandPath(command: string): boolean {
  return path.isAbsolute(command);
}

async function commandExistsOnPath(command: string): Promise<boolean> {
  ensureDefaultPathExpansion();
  try {
    await execFileWithDeadline(PATH_LOOKUP_COMMAND, [command], {
      encoding: 'utf8',
      timeoutMs: COMMAND_LOOKUP_TIMEOUT_MS,
    });
    return true;
  } catch {
    const resolvedPath =
      (await resolveCommandWithWhereis(command)) ?? (await resolveCommandWithLoginShell(command));
    return Boolean(resolvedPath);
  }
}

function assertAbsoluteCommandPath(command: string): void {
  if (!isExecutable(command)) {
    throw new Error(
      `Command '${command}' not found or not executable. Check that it is installed.`,
    );
  }
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  ensureDefaultPathExpansion();
  if (!command || !command.trim()) return false;
  if (isAbsoluteCommandPath(command)) return isExecutable(command);
  return commandExistsOnPath(command);
}

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
  ensureDefaultPathExpansion();
  if (!command || !command.trim()) {
    throw new Error('Command must not be empty.');
  }
  if (isAbsoluteCommandPath(command)) {
    assertAbsoluteCommandPath(command);
    return;
  }
  try {
    execFileSync(PATH_LOOKUP_COMMAND, [command], {
      encoding: 'utf8',
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    if (resolveCommandWithWhereisSync(command) ?? resolveCommandWithLoginShellSync(command)) {
      return;
    }
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}
