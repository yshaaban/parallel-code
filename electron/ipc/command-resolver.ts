import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PATH_LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which';
const LOGIN_SHELL = process.platform === 'win32' ? null : process.env.SHELL || '/bin/bash';
const COMMAND_LOOKUP_TIMEOUT_MS = 3000;
const resolvedCommandCache = new Map<string, string | null>();

// Ensure common user-local directories are in PATH for agent detection.
// Server processes may not inherit an interactive shell's PATH.
const HOME = os.homedir() || process.env.HOME || process.env.USERPROFILE || '';
if (HOME) {
  const extraDirs = [
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.local', 'share', 'pnpm'),
    path.join(HOME, '.npm-global', 'bin'),
    path.join(HOME, '.yarn', 'bin'),
    path.join(HOME, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.cargo', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  if (process.env.PNPM_HOME) extraDirs.unshift(process.env.PNPM_HOME);
  if (process.env.VOLTA_HOME) extraDirs.unshift(path.join(process.env.VOLTA_HOME, 'bin'));
  prependPathEntries(extraDirs);
}

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

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getResolvedPath(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
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
  resolvedCommandCache.set(command, resolvedPath);
  if (resolvedPath && path.isAbsolute(resolvedPath)) {
    prependPathEntries([path.dirname(resolvedPath)]);
  }
  return resolvedPath;
}

async function resolveCommandWithLoginShell(command: string): Promise<string | null> {
  if (!LOGIN_SHELL || isAbsoluteCommandPath(command)) return null;
  if (resolvedCommandCache.has(command)) {
    return resolvedCommandCache.get(command) ?? null;
  }

  try {
    const { stdout } = await execFileAsync(
      LOGIN_SHELL,
      ['-lc', `command -v -- ${quoteForShell(command)}`],
      {
        encoding: 'utf8',
        timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      },
    );
    return cacheResolvedCommand(command, getResolvedPath(stdout));
  } catch {
    return cacheResolvedCommand(command, null);
  }
}

function resolveCommandWithLoginShellSync(command: string): string | null {
  if (!LOGIN_SHELL || isAbsoluteCommandPath(command)) return null;
  if (resolvedCommandCache.has(command)) {
    return resolvedCommandCache.get(command) ?? null;
  }

  try {
    const stdout = execFileSync(LOGIN_SHELL, ['-lc', `command -v -- ${quoteForShell(command)}`], {
      encoding: 'utf8',
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cacheResolvedCommand(command, getResolvedPath(stdout));
  } catch {
    return cacheResolvedCommand(command, null);
  }
}

function isAbsoluteCommandPath(command: string): boolean {
  return path.isAbsolute(command);
}

async function commandExistsOnPath(command: string): Promise<boolean> {
  try {
    await execFileAsync(PATH_LOOKUP_COMMAND, [command], {
      encoding: 'utf8',
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
    });
    return true;
  } catch {
    return Boolean(await resolveCommandWithLoginShell(command));
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
  if (!command || !command.trim()) return false;
  if (isAbsoluteCommandPath(command)) return isExecutable(command);
  return commandExistsOnPath(command);
}

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
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
    if (resolveCommandWithLoginShellSync(command)) {
      return;
    }
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}
