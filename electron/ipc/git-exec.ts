import { execFile, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';

import { recordGitSubprocessStarted } from './runtime-diagnostics.js';

const execFileAsync = promisify(execFile);

export async function execGit(
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  recordGitSubprocessStarted();
  const result = await execFileAsync('git', [...args], options);
  return result as { stdout: string; stderr: string };
}
