import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

function makeExecutable(filePath: string): void {
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
}

posixOnly('command resolver PATH expansion', () => {
  const originalNvmDir = process.env.NVM_DIR;
  const originalNvmHome = process.env.NVM_HOME;
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  afterEach(() => {
    vi.resetModules();
    if (originalNvmDir === undefined) {
      Reflect.deleteProperty(process.env, 'NVM_DIR');
    } else {
      process.env.NVM_DIR = originalNvmDir;
    }
    if (originalNvmHome === undefined) {
      Reflect.deleteProperty(process.env, 'NVM_HOME');
    } else {
      process.env.NVM_HOME = originalNvmHome;
    }
    if (originalPath === undefined) {
      Reflect.deleteProperty(process.env, 'PATH');
    } else {
      process.env.PATH = originalPath;
    }
    if (originalShell === undefined) {
      Reflect.deleteProperty(process.env, 'SHELL');
    } else {
      process.env.SHELL = originalShell;
    }
  });

  it('finds npm-installed agent CLIs under NVM node version bins', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-nvm-path-'));
    const binDir = path.join(tempRoot, '.nvm', 'versions', 'node', 'v20.20.0', 'bin');
    const commandPath = path.join(binDir, 'codex-fixture');

    try {
      fs.mkdirSync(binDir, { recursive: true });
      makeExecutable(commandPath);
      process.env.NVM_DIR = path.join(tempRoot, '.nvm');
      process.env.PATH = fs.existsSync('/usr/bin/which') ? '/usr/bin' : '/bin';
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(binDir);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('finds npm-installed agent CLIs under flat NVM_HOME node version dirs', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-nvm-home-path-'));
    const binDir = path.join(tempRoot, 'nvm-home', 'v20.20.0');
    const commandPath = path.join(binDir, 'codex-fixture');

    try {
      fs.mkdirSync(binDir, { recursive: true });
      makeExecutable(commandPath);
      process.env.NVM_HOME = path.join(tempRoot, 'nvm-home');
      process.env.PATH = fs.existsSync('/usr/bin/which') ? '/usr/bin' : '/bin';
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(binDir);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('ignores noisy shell startup output when using login-shell command lookup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-shell-lookup-'));
    const binDir = path.join(tempRoot, 'bin');
    const shellPath = path.join(tempRoot, 'noisy-shell');
    const commandPath = path.join(binDir, 'codex-shell-fixture');

    try {
      fs.mkdirSync(binDir, { recursive: true });
      makeExecutable(commandPath);
      fs.writeFileSync(
        shellPath,
        [
          '#!/bin/sh',
          'echo "profile startup noise"',
          `echo "__PARALLEL_CODE_RESOLVED_COMMAND__=${commandPath}"`,
        ].join('\n'),
      );
      fs.chmodSync(shellPath, 0o755);
      process.env.SHELL = shellPath;
      process.env.PATH = fs.existsSync('/usr/bin/which') ? '/usr/bin' : '/bin';
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-shell-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(binDir);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses a shell-portable login lookup script for non-POSIX user shells', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-portable-shell-'));
    const binDir = path.join(tempRoot, 'bin');
    const shellPath = path.join(tempRoot, 'strict-shell');
    const commandPath = path.join(binDir, 'codex-portable-shell-fixture');

    try {
      fs.mkdirSync(binDir, { recursive: true });
      makeExecutable(commandPath);
      fs.writeFileSync(
        shellPath,
        [
          '#!/bin/sh',
          'case "$2" in',
          "  *'$('*|*'printf '*) exit 64 ;;",
          'esac',
          `echo "__PARALLEL_CODE_RESOLVED_COMMAND__=${commandPath}"`,
        ].join('\n'),
      );
      fs.chmodSync(shellPath, 0o755);
      process.env.SHELL = shellPath;
      process.env.PATH = fs.existsSync('/usr/bin/which') ? '/usr/bin' : '/bin';
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-portable-shell-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(binDir);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not keep a stale negative cache after a CLI is installed later', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-late-cli-'));
    const binDir = path.join(tempRoot, 'bin');
    const markerPath = path.join(tempRoot, 'installed');
    const shellPath = path.join(tempRoot, 'lookup-shell');
    const commandPath = path.join(binDir, 'codex-late-fixture');

    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        shellPath,
        [
          '#!/bin/sh',
          `if [ -f "${markerPath}" ]; then`,
          `  echo "__PARALLEL_CODE_RESOLVED_COMMAND__=${commandPath}"`,
          '  exit 0',
          'fi',
          'exit 1',
        ].join('\n'),
      );
      fs.chmodSync(shellPath, 0o755);
      process.env.SHELL = shellPath;
      process.env.PATH = fs.existsSync('/usr/bin/which') ? '/usr/bin' : '/bin';
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-late-fixture')).toThrow(
        "Command 'codex-late-fixture' not found in PATH.",
      );

      makeExecutable(commandPath);
      fs.writeFileSync(markerPath, 'installed\n');

      expect(() => validateCommand('codex-late-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(binDir);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to whereis when server PATH and login shell lookup miss a command', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-whereis-cli-'));
    const commandDir = path.join(tempRoot, 'installed-bin');
    const toolDir = path.join(tempRoot, 'tools');
    const commandPath = path.join(commandDir, 'codex-whereis-fixture');
    const shellPath = path.join(toolDir, 'missing-shell');

    try {
      fs.mkdirSync(commandDir, { recursive: true });
      fs.mkdirSync(toolDir, { recursive: true });
      makeExecutable(commandPath);
      fs.writeFileSync(path.join(toolDir, 'which'), '#!/bin/sh\nexit 1\n');
      fs.writeFileSync(
        path.join(toolDir, 'whereis'),
        `#!/bin/sh\necho "codex-whereis-fixture: ${commandPath}"\n`,
      );
      fs.writeFileSync(shellPath, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(path.join(toolDir, 'which'), 0o755);
      fs.chmodSync(path.join(toolDir, 'whereis'), 0o755);
      fs.chmodSync(shellPath, 0o755);
      process.env.SHELL = shellPath;
      process.env.PATH = toolDir;
      vi.resetModules();

      const { validateCommand } = await import('./command-resolver.js');

      expect(() => validateCommand('codex-whereis-fixture')).not.toThrow();
      expect(process.env.PATH?.split(path.delimiter)).toContain(commandDir);

      process.env.PATH = toolDir;
      vi.resetModules();
      const { isCommandAvailable: isCommandAvailableAfterReset } =
        await import('./command-resolver.js');

      expect(await isCommandAvailableAfterReset('codex-whereis-fixture')).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
