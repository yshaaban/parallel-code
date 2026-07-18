import fs from 'node:fs';
import path from 'node:path';

import { TEST_SHELL_HOME_ENV_KEY } from '../../src/lib/test-shell-env.js';

type TestShellKind = 'bash' | 'fish' | 'posix' | 'powershell' | 'zsh' | 'unknown';

const POWERSHELL_NO_PROFILE_PATTERN = /^-(?:noprofile|nop)$/iu;
const POWERSHELL_PAYLOAD_BOUNDARY_PATTERN =
  /^(?:--%|-(?:c|command|commandwithargs|cwa|e|ec|encodedcommand|f|file))$/iu;

interface ApplyTestShellSandboxOptions {
  command: string;
  commandArgs: string[];
  configuredShellHomePath: string | undefined;
  isShell: boolean;
  platform: NodeJS.Platform;
  spawnEnv: Record<string, string>;
}

function normalizeEnvKey(key: string): string {
  return key.toUpperCase();
}

function deleteEnvKey(env: Record<string, string>, key: string): void {
  const normalizedKey = normalizeEnvKey(key);
  for (const envKey of Object.keys(env)) {
    if (normalizeEnvKey(envKey) === normalizedKey) {
      Reflect.deleteProperty(env, envKey);
    }
  }
}

function setEnvKey(env: Record<string, string>, key: string, value: string): void {
  deleteEnvKey(env, key);
  env[key] = value;
}

function writeFileIfChanged(filePath: string, contents: string): void {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === contents) {
    return;
  }

  fs.writeFileSync(filePath, contents, 'utf8');
}

function getCommandBasename(command: string): string {
  return path
    .basename(command)
    .toLowerCase()
    .replace(/\.(?:bat|cmd|exe)$/u, '');
}

function getTestShellKind(command: string): TestShellKind {
  switch (getCommandBasename(command)) {
    case 'bash':
      return 'bash';
    case 'fish':
      return 'fish';
    case 'ash':
    case 'dash':
    case 'ksh':
    case 'mksh':
    case 'sh':
      return 'posix';
    case 'powershell':
    case 'pwsh':
      return 'powershell';
    case 'zsh':
      return 'zsh';
    default:
      return 'unknown';
  }
}

function hasPowerShellNoProfileOption(commandArgs: readonly string[]): boolean {
  for (const arg of commandArgs) {
    if (POWERSHELL_PAYLOAD_BOUNDARY_PATTERN.test(arg)) {
      return false;
    }
    if (POWERSHELL_NO_PROFILE_PATTERN.test(arg)) {
      return true;
    }
  }

  return false;
}

function createTestShellSandboxEnv(
  shellHomePath: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const appDataPath = path.join(shellHomePath, '.app-data');
  const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null';

  return {
    APPDATA: path.join(appDataPath, 'roaming'),
    HISTFILE: path.join(shellHomePath, '.shell_history'),
    HISTFILESIZE: '0',
    HISTSIZE: '0',
    HOME: shellHomePath,
    INPUTRC: path.join(shellHomePath, '.inputrc'),
    LESSHISTFILE: '-',
    LOCALAPPDATA: path.join(appDataPath, 'local'),
    NODE_REPL_HISTORY: path.join(shellHomePath, '.node_repl_history'),
    PYTHONHISTFILE: nullDevice,
    SAVEHIST: '0',
    SQLITE_HISTORY: nullDevice,
    USERPROFILE: shellHomePath,
    XDG_CACHE_HOME: path.join(shellHomePath, '.cache'),
    XDG_CONFIG_HOME: path.join(shellHomePath, '.config'),
    XDG_DATA_HOME: path.join(shellHomePath, '.local', 'share'),
    XDG_STATE_HOME: path.join(shellHomePath, '.local', 'state'),
  };
}

function ensureTestShellHome(shellHomePath: string, shellKind: TestShellKind): void {
  fs.mkdirSync(shellHomePath, { recursive: true });
  writeFileIfChanged(path.join(shellHomePath, '.inputrc'), '');
  writeFileIfChanged(
    path.join(shellHomePath, '.shellrc'),
    [
      'HISTFILE="$HOME/.shell_history"',
      'HISTFILESIZE=0',
      'HISTSIZE=0',
      'export HISTFILE HISTFILESIZE HISTSIZE',
      "PS1='$ '",
      'export PS1',
      'set +o history 2>/dev/null || :',
      '',
    ].join('\n'),
  );
  writeFileIfChanged(path.join(shellHomePath, '.profile'), '. "$HOME/.shellrc"\n');

  if (shellKind === 'zsh') {
    const zdotdir = path.join(shellHomePath, '.config', 'zsh');
    fs.mkdirSync(zdotdir, { recursive: true });
    writeFileIfChanged(
      path.join(zdotdir, '.zshenv'),
      ['export HISTFILE="$HOME/.shell_history"', 'export HISTSIZE=0', 'export SAVEHIST=0', ''].join(
        '\n',
      ),
    );
    writeFileIfChanged(
      path.join(zdotdir, '.zshrc'),
      [
        'export HISTFILE="$HOME/.shell_history"',
        'export HISTSIZE=0',
        'export SAVEHIST=0',
        'unsetopt APPEND_HISTORY',
        'unsetopt EXTENDED_HISTORY',
        'unsetopt HIST_EXPIRE_DUPS_FIRST',
        'unsetopt HIST_FIND_NO_DUPS',
        'unsetopt HIST_IGNORE_ALL_DUPS',
        'unsetopt HIST_IGNORE_DUPS',
        'unsetopt HIST_REDUCE_BLANKS',
        'unsetopt HIST_SAVE_NO_DUPS',
        'unsetopt INC_APPEND_HISTORY',
        'unsetopt INC_APPEND_HISTORY_TIME',
        'unsetopt SHARE_HISTORY',
        "PROMPT='%# '",
        'RPROMPT=',
        '',
      ].join('\n'),
    );
    return;
  }

  if (shellKind === 'bash') {
    writeFileIfChanged(path.join(shellHomePath, '.bashrc'), ['. "$HOME/.shellrc"', ''].join('\n'));
    writeFileIfChanged(path.join(shellHomePath, '.bash_profile'), '. "$HOME/.bashrc"\n');
    return;
  }

  if (shellKind === 'fish') {
    const fishConfigDirectory = path.join(shellHomePath, '.config', 'fish');
    fs.mkdirSync(fishConfigDirectory, { recursive: true });
    writeFileIfChanged(
      path.join(fishConfigDirectory, 'config.fish'),
      ["set -g fish_history ''", 'function fish_prompt', "    echo -n '$ '", 'end', ''].join('\n'),
    );
  }
}

export function applyTestShellSandbox(options: ApplyTestShellSandboxOptions): string[] {
  deleteEnvKey(options.spawnEnv, TEST_SHELL_HOME_ENV_KEY);

  const configuredShellHomePath = options.configuredShellHomePath?.trim();
  if (!options.isShell || !configuredShellHomePath) {
    return options.commandArgs;
  }

  const shellHomePath = path.resolve(configuredShellHomePath);
  const shellKind = getTestShellKind(options.command);
  ensureTestShellHome(shellHomePath, shellKind);
  for (const [key, value] of Object.entries(
    createTestShellSandboxEnv(shellHomePath, options.platform),
  )) {
    setEnvKey(options.spawnEnv, key, value);
  }

  if (shellKind === 'zsh') {
    setEnvKey(options.spawnEnv, 'ZDOTDIR', path.join(shellHomePath, '.config', 'zsh'));
  } else if (shellKind === 'bash' || shellKind === 'posix') {
    const shellRcPath = path.join(shellHomePath, '.shellrc');
    setEnvKey(options.spawnEnv, 'BASH_ENV', shellRcPath);
    setEnvKey(options.spawnEnv, 'ENV', shellRcPath);
  } else if (shellKind === 'fish') {
    setEnvKey(options.spawnEnv, 'fish_history', '');
  } else if (shellKind === 'powershell' && !hasPowerShellNoProfileOption(options.commandArgs)) {
    return ['-NoProfile', ...options.commandArgs];
  }

  return options.commandArgs;
}
