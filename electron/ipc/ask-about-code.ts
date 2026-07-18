import type {
  AskAboutCodeMessage,
  AskAboutCodeProviderId,
} from '../../src/domain/ask-about-code.js';
import { spawnWithDeadline, type BoundedSpawn, type SubprocessExit } from './bounded-process.js';
import { validateCommand } from './command-resolver.js';
import { BadRequestError } from './errors.js';

export interface AskAboutCodeRequest {
  cwd: string;
  prompt: string;
  providerId?: AskAboutCodeProviderId;
  requestId: string;
}

export const MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS = 5;
export const MAX_ASK_ABOUT_CODE_PROMPT_LENGTH = 50_000;
export const ASK_ABOUT_CODE_TIMEOUT_MS = 120_000;
export const ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS = 5_000;

interface OwnedAskAboutCodeRequest {
  bounded: BoundedSpawn;
  requestId: string;
  settled: Promise<void>;
}

const activeRequestOwners = new Map<string, OwnedAskAboutCodeRequest>();
const ownedRequests = new Set<OwnedAskAboutCodeRequest>();
let stoppingAllRequests = false;
let stopAllRequestsPromise: Promise<void> | null = null;

class AskAboutCodeCancellationError extends Error {
  constructor() {
    super('Ask-about-code request cancelled');
    this.name = 'AskAboutCodeCancellationError';
  }
}

class AskAboutCodeTimeoutError extends Error {
  constructor() {
    super('Request timed out after 2 minutes.');
    this.name = 'AskAboutCodeTimeoutError';
  }
}

export class AskAboutCodeCleanupError extends Error {
  constructor(readonly failures: unknown[]) {
    super('Failed to stop all ask-about-code requests');
    this.name = 'AskAboutCodeCleanupError';
  }
}

export class AskAboutCodeRequestLifecycleError extends Error {
  constructor(
    readonly requestId: string,
    readonly lifecycleError: Error,
  ) {
    super(
      `Ask-about-code request ${requestId} did not clean up reliably: ${lifecycleError.message}`,
    );
    this.name = 'AskAboutCodeRequestLifecycleError';
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createClaudeEnvironment(): NodeJS.ProcessEnv {
  const nextEnvironment = { ...process.env };
  delete nextEnvironment.CLAUDECODE;
  delete nextEnvironment.CLAUDE_CODE_SESSION;
  delete nextEnvironment.CLAUDE_CODE_ENTRYPOINT;
  return nextEnvironment;
}

interface AskAboutCodeProviderLaunch {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
}

function createClaudeProviderLaunch(prompt: string): AskAboutCodeProviderLaunch {
  return {
    command: 'claude',
    args: [
      '-p',
      prompt,
      '--output-format',
      'text',
      '--model',
      'sonnet',
      '--tools',
      '',
      '--no-session-persistence',
      '--append-system-prompt',
      'Answer concisely about the selected code. Use markdown.',
    ],
    env: createClaudeEnvironment(),
  };
}

function createMinimaxProviderLaunch(prompt: string): AskAboutCodeProviderLaunch {
  return {
    command: process.env.PARALLEL_CODE_MINIMAX_COMMAND?.trim() || 'minimax',
    args: [
      ...(process.env.PARALLEL_CODE_MINIMAX_ARGS?.trim().split(/\s+/u).filter(Boolean) ?? []),
      prompt,
    ],
    env: { ...process.env },
  };
}

function resolveProviderLaunch(
  providerId: AskAboutCodeProviderId,
  prompt: string,
): AskAboutCodeProviderLaunch {
  switch (providerId) {
    case 'claude':
      return createClaudeProviderLaunch(prompt);
    case 'minimax':
      return createMinimaxProviderLaunch(prompt);
  }
}

function cleanupRequest(owner: OwnedAskAboutCodeRequest): void {
  if (activeRequestOwners.get(owner.requestId) === owner) {
    activeRequestOwners.delete(owner.requestId);
  }

  ownedRequests.delete(owner);
}

export function cancelAskAboutCode(requestId: string): void {
  activeRequestOwners.get(requestId)?.bounded.terminate(new AskAboutCodeCancellationError());
}

export function askAboutCode(
  request: AskAboutCodeRequest,
  onOutput: (message: AskAboutCodeMessage) => void,
): void {
  const { cwd, prompt, requestId } = request;

  if (stoppingAllRequests) {
    throw new BadRequestError('Ask-about-code runtime is shutting down');
  }

  if (prompt.length > MAX_ASK_ABOUT_CODE_PROMPT_LENGTH) {
    throw new BadRequestError(
      `prompt must not exceed ${MAX_ASK_ABOUT_CODE_PROMPT_LENGTH} characters`,
    );
  }

  if (ownedRequests.size >= MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS) {
    throw new BadRequestError('Too many concurrent ask-about-code requests');
  }

  const providerId = request.providerId ?? 'claude';
  const launch = resolveProviderLaunch(providerId, prompt);
  validateCommand(launch.command);

  const bounded = spawnWithDeadline(
    launch.command,
    launch.args,
    {
      cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    {
      createTimeoutError: () => new AskAboutCodeTimeoutError(),
      terminateGraceMs: ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS,
      timeoutMs: ASK_ABOUT_CODE_TIMEOUT_MS,
    },
  );
  const { child: proc, completion } = bounded;
  cancelAskAboutCode(requestId);

  let finished = false;

  const handleStdout = (chunk: Buffer | string): void => {
    onOutput({
      type: 'chunk',
      text: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
  };

  const handleStderr = (chunk: Buffer | string): void => {
    onOutput({
      type: 'error',
      text: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
  };

  const handleStreamError = (error: Error): void => {
    bounded.terminate(error);
  };

  function finish(exit: SubprocessExit | undefined, error: Error | undefined): void {
    if (finished) {
      return;
    }

    finished = true;
    proc.stdout?.off('data', handleStdout);
    proc.stdout?.off('error', handleStreamError);
    proc.stderr?.off('data', handleStderr);
    proc.stderr?.off('error', handleStreamError);
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    if (error instanceof AskAboutCodeTimeoutError) {
      onOutput({ type: 'error', text: error.message });
      onOutput({ type: 'done', exitCode: 1 });
      return;
    }
    if (error instanceof AskAboutCodeCancellationError) {
      onOutput({ type: 'done', exitCode: null });
      return;
    }
    if (error) {
      onOutput({ type: 'error', text: error.message });
      onOutput({ type: 'done', exitCode: 1 });
      return;
    }
    onOutput({ type: 'done', exitCode: exit?.code ?? null });
  }

  const owner: OwnedAskAboutCodeRequest = {
    bounded,
    requestId,
    settled: Promise.resolve(),
  };
  owner.settled = completion
    .then(
      (exit) => finish(exit, undefined),
      (error: unknown) => {
        const lifecycleError = normalizeError(error);
        finish(undefined, lifecycleError);

        const forcedTerminationError = bounded.forcedTerminationError;
        if (forcedTerminationError) {
          throw new AskAboutCodeRequestLifecycleError(requestId, forcedTerminationError);
        }
        if (
          lifecycleError instanceof AskAboutCodeCancellationError ||
          lifecycleError instanceof AskAboutCodeTimeoutError
        ) {
          return;
        }
        throw new AskAboutCodeRequestLifecycleError(requestId, lifecycleError);
      },
    )
    .finally(() => cleanupRequest(owner));
  void owner.settled.catch(() => {});
  activeRequestOwners.set(requestId, owner);
  ownedRequests.add(owner);

  proc.stdout?.on('data', handleStdout);
  proc.stdout?.on('error', handleStreamError);
  proc.stderr?.on('data', handleStderr);
  proc.stderr?.on('error', handleStreamError);
}

export function stopAllAskAboutCodeRequests(): Promise<void> {
  if (stopAllRequestsPromise) {
    return stopAllRequestsPromise;
  }

  stoppingAllRequests = true;
  const stopOperation = (async () => {
    const failures: unknown[] = [];
    while (ownedRequests.size > 0) {
      const owners = [...ownedRequests];
      for (const owner of owners) {
        owner.bounded.terminate(new AskAboutCodeCancellationError());
      }

      const results = await Promise.allSettled(owners.map((owner) => owner.settled));
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
        }
      }
    }

    if (failures.length > 0) {
      throw new AskAboutCodeCleanupError(failures);
    }
  })();
  const stopPromise = stopOperation.finally(() => {
    if (stopAllRequestsPromise === stopPromise) {
      stoppingAllRequests = false;
      stopAllRequestsPromise = null;
    }
  });
  stopAllRequestsPromise = stopPromise;
  return stopPromise;
}

export function resetAskAboutCodeState(): void {
  for (const owner of ownedRequests) {
    owner.bounded.terminate(new AskAboutCodeCancellationError());
  }
  activeRequestOwners.clear();
  ownedRequests.clear();
  stoppingAllRequests = false;
  stopAllRequestsPromise = null;
}
