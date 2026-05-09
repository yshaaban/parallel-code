import { spawn } from 'node:child_process';
import process from 'node:process';

export function getCommandBin(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

export function runCommand(command, args, { cwd, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(getCommandBin(command), args, {
      cwd,
      stdio,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
      });
    });
  });
}
