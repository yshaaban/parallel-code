import {
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'child_process';

import { withDefaultGitExecTimeout } from './git-process-policy.js';
import { recordGitSubprocessStarted } from './runtime-diagnostics.js';

export function execGitSync(
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string | null;
export function execGitSync(
  args: readonly string[],
  options: ExecFileSyncOptionsWithBufferEncoding,
): Buffer | null;
export function execGitSync(
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer | null;
export function execGitSync(
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): string | Buffer | null {
  recordGitSubprocessStarted();
  return execFileSync('git', [...args], withDefaultGitExecTimeout(options));
}
