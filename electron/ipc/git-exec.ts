import { type ExecFileOptions, type ExecFileOptionsWithBufferEncoding } from 'child_process';

import {
  DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS,
  DEFAULT_SUBPROCESS_TERMINATE_GRACE_MS,
  execFileWithDeadline,
  spawnWithDeadline,
  type BoundedSpawn,
  type BoundedSpawnOptions,
  type SubprocessExit,
} from './bounded-process.js';
import { DEFAULT_GIT_EXEC_TIMEOUT_MS } from './git-process-policy.js';
import { recordGitSubprocessStarted } from './runtime-diagnostics.js';

export { DEFAULT_GIT_EXEC_TIMEOUT_MS } from './git-process-policy.js';

export const GIT_SPAWN_TERMINATE_GRACE_MS = DEFAULT_SUBPROCESS_TERMINATE_GRACE_MS;
export const GIT_SPAWN_FORCE_KILL_CLOSE_GRACE_MS = DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS;

export interface GitSpawnLifecycleOptions {
  forceKillCloseGraceMs?: number;
  signal?: AbortSignal;
  terminateGraceMs?: number;
  timeoutMs?: number;
}

export type GitSpawnExit = SubprocessExit;
export type BoundedGitSpawn = BoundedSpawn;

export class GitSpawnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Git subprocess timed out after ${timeoutMs}ms`);
    this.name = 'GitSpawnTimeoutError';
  }
}

/**
 * Spawns Git with one backend-owned lifecycle. A deadline first requests graceful termination,
 * then force-kills a child that does not close, and finally settles even when a broken child
 * implementation never reports closure. Callers may start the same bounded termination path for
 * operation-specific cancellation, and completion never reports success after termination starts.
 */
export function spawnGitWithDeadline(
  args: readonly string[],
  options: BoundedSpawnOptions = {},
  lifecycleOptions: GitSpawnLifecycleOptions = {},
): BoundedGitSpawn {
  const timeoutMs = lifecycleOptions.timeoutMs ?? DEFAULT_GIT_EXEC_TIMEOUT_MS;
  const terminateGraceMs = lifecycleOptions.terminateGraceMs ?? GIT_SPAWN_TERMINATE_GRACE_MS;
  const forceKillCloseGraceMs =
    lifecycleOptions.forceKillCloseGraceMs ?? GIT_SPAWN_FORCE_KILL_CLOSE_GRACE_MS;

  const bounded = spawnWithDeadline('git', args, options, {
    createTimeoutError: (durationMs) => new GitSpawnTimeoutError(durationMs),
    forceKillCloseGraceMs,
    signal: lifecycleOptions.signal,
    terminateGraceMs,
    timeoutMs,
  });
  recordGitSubprocessStarted();
  return bounded;
}

type GitExecOptions = Omit<ExecFileOptions, 'encoding' | 'killSignal'> & {
  encoding?: BufferEncoding;
  input?: Buffer | string | undefined;
};

type GitExecBufferOptions = Omit<ExecFileOptionsWithBufferEncoding, 'encoding' | 'killSignal'> & {
  input?: Buffer | string | undefined;
};

export async function execGit(
  args: readonly string[],
  options: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { input, timeout, ...execOptions } = options;
  const execution = execFileWithDeadline('git', args, {
    ...execOptions,
    encoding: options.encoding ?? 'utf8',
    input,
    timeoutMs: timeout ?? DEFAULT_GIT_EXEC_TIMEOUT_MS,
  });
  if (!options.signal?.aborted) {
    recordGitSubprocessStarted();
  }
  return execution;
}

export async function execGitBuffer(
  args: readonly string[],
  options: GitExecBufferOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const { input, timeout, ...execOptions } = options;
  const execution = execFileWithDeadline('git', args, {
    ...execOptions,
    encoding: 'buffer',
    input,
    timeoutMs: timeout ?? DEFAULT_GIT_EXEC_TIMEOUT_MS,
  });
  if (!options.signal?.aborted) {
    recordGitSubprocessStarted();
  }
  return execution;
}
