import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyTestShellSandbox } from './test-shell-sandbox.js';

function withTemporaryDirectory(run: (directoryPath: string) => void): void {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-shell-sandbox-'));
  try {
    run(directoryPath);
  } finally {
    fs.rmSync(directoryPath, { force: true, recursive: true });
  }
}

function applySandbox(options: {
  command: string;
  commandArgs?: string[];
  isShell?: boolean;
  platform?: NodeJS.Platform;
  shellHomePath: string | undefined;
  spawnEnv?: Record<string, string>;
}): { commandArgs: string[]; spawnEnv: Record<string, string> } {
  const spawnEnv = options.spawnEnv ?? {};
  const commandArgs = options.commandArgs ?? [];

  return {
    commandArgs: applyTestShellSandbox({
      command: options.command,
      commandArgs,
      configuredShellHomePath: options.shellHomePath,
      isShell: options.isShell ?? true,
      platform: options.platform ?? 'linux',
      spawnEnv,
    }),
    spawnEnv,
  };
}

describe('test shell sandbox', () => {
  it.each([
    {
      command: '/bin/zsh.exe',
      expectedEnv: (shellHomePath: string) => ({
        ZDOTDIR: path.join(shellHomePath, '.config', 'zsh'),
      }),
      expectedFiles: [
        ['.config/zsh/.zshenv', 'HISTFILE="$HOME/.shell_history"'],
        ['.config/zsh/.zshrc', "PROMPT='%# '"],
      ],
      name: 'zsh',
    },
    {
      command: '/bin/bash',
      expectedEnv: (shellHomePath: string) => ({
        BASH_ENV: path.join(shellHomePath, '.shellrc'),
        ENV: path.join(shellHomePath, '.shellrc'),
      }),
      expectedFiles: [
        ['.bash_profile', '. "$HOME/.bashrc"'],
        ['.bashrc', '. "$HOME/.shellrc"'],
      ],
      name: 'bash',
    },
    {
      command: '/bin/dash',
      expectedEnv: (shellHomePath: string) => ({
        BASH_ENV: path.join(shellHomePath, '.shellrc'),
        ENV: path.join(shellHomePath, '.shellrc'),
      }),
      expectedFiles: [['.profile', '. "$HOME/.shellrc"']],
      name: 'POSIX',
    },
    {
      command: '/bin/fish',
      expectedEnv: () => ({
        fish_history: '',
      }),
      expectedFiles: [['.config/fish/config.fish', "set -g fish_history ''"]],
      name: 'Fish',
    },
  ])('materializes the $name startup contract', (testCase) => {
    withTemporaryDirectory((directoryPath) => {
      const shellHomePath = path.join(directoryPath, 'shell-home');
      const result = applySandbox({
        command: testCase.command,
        commandArgs: ['-l'],
        shellHomePath,
      });

      expect(result.commandArgs).toEqual(['-l']);
      expect(result.spawnEnv).toMatchObject({
        APPDATA: path.join(shellHomePath, '.app-data', 'roaming'),
        HISTFILE: path.join(shellHomePath, '.shell_history'),
        HISTFILESIZE: '0',
        HISTSIZE: '0',
        HOME: shellHomePath,
        LOCALAPPDATA: path.join(shellHomePath, '.app-data', 'local'),
        PYTHONHISTFILE: '/dev/null',
        SAVEHIST: '0',
        SQLITE_HISTORY: '/dev/null',
        USERPROFILE: shellHomePath,
        XDG_CONFIG_HOME: path.join(shellHomePath, '.config'),
        XDG_DATA_HOME: path.join(shellHomePath, '.local', 'share'),
        XDG_STATE_HOME: path.join(shellHomePath, '.local', 'state'),
        ...testCase.expectedEnv(shellHomePath),
      });
      for (const [relativePath, expectedText] of testCase.expectedFiles) {
        expect(fs.readFileSync(path.join(shellHomePath, relativePath), 'utf8')).toContain(
          expectedText,
        );
      }
    });
  });

  it('prepends PowerShell no-profile before command arguments', () => {
    withTemporaryDirectory((directoryPath) => {
      const shellHomePath = path.join(directoryPath, 'shell-home');
      const result = applySandbox({
        command: 'pwsh.exe',
        commandArgs: ['-Command', 'Write-Output "sandboxed"'],
        platform: 'win32',
        shellHomePath,
      });

      expect(result.commandArgs).toEqual(['-NoProfile', '-Command', 'Write-Output "sandboxed"']);
      expect(result.spawnEnv).toMatchObject({
        APPDATA: path.join(shellHomePath, '.app-data', 'roaming'),
        LOCALAPPDATA: path.join(shellHomePath, '.app-data', 'local'),
        PYTHONHISTFILE: 'NUL',
        SQLITE_HISTORY: 'NUL',
        USERPROFILE: shellHomePath,
      });
    });
  });

  it.each(['-NoProfile', '-nop'])(
    'does not duplicate an explicit PowerShell no-profile argument',
    (commandArg) => {
      withTemporaryDirectory((directoryPath) => {
        const result = applySandbox({
          command: 'powershell.exe',
          commandArgs: [commandArg],
          shellHomePath: path.join(directoryPath, 'shell-home'),
        });

        expect(result.commandArgs).toEqual([commandArg]);
      });
    },
  );

  it.each([
    ['-Command', '-NoProfile'],
    ['-cwa', '-NoProfile'],
    ['-File', 'script.ps1', '-nop'],
    ['-EncodedCommand', '-NoProfile'],
  ])('does not mistake PowerShell payload data for an interpreter no-profile option', (...args) => {
    withTemporaryDirectory((directoryPath) => {
      const result = applySandbox({
        command: 'pwsh.exe',
        commandArgs: args,
        shellHomePath: path.join(directoryPath, 'shell-home'),
      });

      expect(result.commandArgs).toEqual(['-NoProfile', ...args]);
    });
  });

  it('redirects common history and home state for an unknown shell', () => {
    withTemporaryDirectory((directoryPath) => {
      const shellHomePath = path.join(directoryPath, 'shell-home');
      const result = applySandbox({
        command: '/usr/local/bin/custom-shell',
        shellHomePath,
      });

      expect(result.spawnEnv).toMatchObject({
        HISTFILE: path.join(shellHomePath, '.shell_history'),
        HOME: shellHomePath,
        USERPROFILE: shellHomePath,
      });
      expect(result.spawnEnv.ZDOTDIR).toBeUndefined();
      expect(result.spawnEnv.BASH_ENV).toBeUndefined();
    });
  });

  it('does not sandbox non-shell launches and always removes the control env', () => {
    withTemporaryDirectory((directoryPath) => {
      const shellHomePath = path.join(directoryPath, 'shell-home');
      const result = applySandbox({
        command: process.execPath,
        commandArgs: ['--version'],
        isShell: false,
        shellHomePath,
        spawnEnv: {
          HOME: '/original/home',
          parallel_code_test_shell_home: shellHomePath,
        },
      });

      expect(result.commandArgs).toEqual(['--version']);
      expect(result.spawnEnv).toEqual({
        HOME: '/original/home',
      });
      expect(fs.existsSync(shellHomePath)).toBe(false);
    });
  });

  it('does nothing without a configured shell home', () => {
    const result = applySandbox({
      command: '/bin/zsh',
      shellHomePath: undefined,
      spawnEnv: {
        HOME: '/original/home',
        PARALLEL_CODE_TEST_SHELL_HOME: '',
      },
    });

    expect(result.spawnEnv).toEqual({
      HOME: '/original/home',
    });
  });
});
