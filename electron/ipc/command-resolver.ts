import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PATH_LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which';

function isAbsoluteCommandPath(command: string): boolean {
  return path.isAbsolute(command);
}

async function commandExistsOnPath(command: string): Promise<boolean> {
  try {
    await execFileAsync(PATH_LOOKUP_COMMAND, [command], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function assertAbsoluteCommandPath(command: string): void {
  try {
    fs.accessSync(command, fs.constants.X_OK);
  } catch {
    throw new Error(
      `Command '${command}' not found or not executable. Check that it is installed.`,
    );
  }
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  if (!command || !command.trim()) return false;
  if (isAbsoluteCommandPath(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
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
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}
