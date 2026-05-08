import fs from 'fs';
import { execFileSync } from 'child_process';
import * as os from 'os';

const LOGIN_ENV_SENTINEL = '__PCODE_ENV__';
const LOGIN_ENV_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const PROTECTED_LOGIN_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

interface ResolveUserShellDeps {
  canUseShell?: (shell: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  userInfo?: () => { shell: string | null | undefined };
}

interface ApplyLoginShellEnvironmentDeps {
  env?: NodeJS.ProcessEnv;
  execFileSync?: typeof execFileSync;
  platform?: NodeJS.Platform;
  resolveShell?: () => string;
  warn?: (message: string, error: unknown) => void;
}

function normalizeShell(shell: string | null | undefined): string | null {
  const value = shell?.trim();
  return value ? value : null;
}

function isExecutablePosixShell(shell: string): boolean {
  try {
    fs.accessSync(shell, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveUserShell(deps: ResolveUserShellDeps = {}): string {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const userInfo = deps.userInfo ?? os.userInfo;
  const canUseShell =
    deps.canUseShell ?? ((shell: string) => platform === 'win32' || isExecutablePosixShell(shell));

  try {
    const osShell = normalizeShell(userInfo().shell);
    if (osShell && canUseShell(osShell)) {
      return osShell;
    }
  } catch {
    // Fall back to the inherited environment when the OS lookup is unavailable.
  }

  const envShell = normalizeShell(env.SHELL);
  if (envShell && canUseShell(envShell)) {
    return envShell;
  }

  return platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

function parseLoginShellEnvironment(result: string): Array<[string, string]> {
  const startIndex = result.indexOf(LOGIN_ENV_SENTINEL);
  const endIndex = result.lastIndexOf(LOGIN_ENV_SENTINEL);
  if (startIndex === -1 || endIndex === -1 || startIndex === endIndex) {
    return [];
  }

  const envBlock = result.slice(startIndex + LOGIN_ENV_SENTINEL.length, endIndex);
  const entries: Array<[string, string]> = [];
  for (const entry of envBlock.split('\0')) {
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    entries.push([entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)]);
  }
  return entries;
}

export function applyLoginShellEnvironment(deps: ApplyLoginShellEnvironmentDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    return;
  }

  const env = deps.env ?? process.env;
  const run = deps.execFileSync ?? execFileSync;
  const resolveShell = deps.resolveShell ?? resolveUserShell;
  const warn = deps.warn ?? console.warn;

  try {
    const loginShell = resolveShell();
    const output = run(
      loginShell,
      [
        '-ilc',
        `printf '${LOGIN_ENV_SENTINEL}' && perl -e 'print "$_=$ENV{$_}\\0" for keys %ENV' && printf '${LOGIN_ENV_SENTINEL}'`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: LOGIN_ENV_MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );

    for (const [key, value] of parseLoginShellEnvironment(String(output))) {
      if (!PROTECTED_LOGIN_ENV_KEYS.has(key)) {
        env[key] = value;
      }
    }
  } catch (error) {
    warn('[fixEnv] Failed to resolve login shell environment:', error);
  }
}
