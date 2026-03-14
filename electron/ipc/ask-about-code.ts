import { spawn, type ChildProcess } from 'child_process';

import type { AskAboutCodeMessage } from '../../src/domain/ask-about-code.js';
import { validateCommand } from './command-resolver.js';
import { BadRequestError } from './errors.js';

export interface AskAboutCodeRequest {
  cwd: string;
  prompt: string;
  requestId: string;
}

export const MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS = 5;
export const MAX_ASK_ABOUT_CODE_PROMPT_LENGTH = 50_000;
export const ASK_ABOUT_CODE_TIMEOUT_MS = 120_000;

const activeRequests = new Map<string, ChildProcess>();
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function createClaudeEnvironment(): NodeJS.ProcessEnv {
  const nextEnvironment = { ...process.env };
  delete nextEnvironment.CLAUDECODE;
  delete nextEnvironment.CLAUDE_CODE_SESSION;
  delete nextEnvironment.CLAUDE_CODE_ENTRYPOINT;
  return nextEnvironment;
}

function clearRequestTimer(requestId: string): void {
  const timer = activeTimers.get(requestId);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  activeTimers.delete(requestId);
}

function cleanupRequest(requestId: string): void {
  activeRequests.delete(requestId);
  clearRequestTimer(requestId);
}

export function cancelAskAboutCode(requestId: string): void {
  const proc = activeRequests.get(requestId);
  if (proc) {
    proc.kill('SIGTERM');
    activeRequests.delete(requestId);
  }

  clearRequestTimer(requestId);
}

export function askAboutCode(
  request: AskAboutCodeRequest,
  onOutput: (message: AskAboutCodeMessage) => void,
): void {
  const { cwd, prompt, requestId } = request;

  if (prompt.length > MAX_ASK_ABOUT_CODE_PROMPT_LENGTH) {
    throw new BadRequestError(
      `prompt must not exceed ${MAX_ASK_ABOUT_CODE_PROMPT_LENGTH} characters`,
    );
  }

  if (
    activeRequests.size >= MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS &&
    !activeRequests.has(requestId)
  ) {
    throw new BadRequestError('Too many concurrent ask-about-code requests');
  }

  cancelAskAboutCode(requestId);
  validateCommand('claude');

  const proc = spawn(
    'claude',
    [
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
    {
      cwd,
      env: createClaudeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  activeRequests.set(requestId, proc);

  let finished = false;

  proc.stdout?.on('data', (chunk: Buffer | string) => {
    onOutput({
      type: 'chunk',
      text: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
  });

  proc.stderr?.on('data', (chunk: Buffer | string) => {
    onOutput({
      type: 'error',
      text: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
  });

  proc.on('close', (exitCode) => {
    cleanupRequest(requestId);
    if (finished) {
      return;
    }

    finished = true;
    onOutput({ type: 'done', exitCode });
  });

  proc.on('error', (error) => {
    cleanupRequest(requestId);
    if (finished) {
      return;
    }

    finished = true;
    onOutput({ type: 'error', text: error.message });
    onOutput({ type: 'done', exitCode: 1 });
  });

  const timer = setTimeout(() => {
    activeTimers.delete(requestId);
    if (!activeRequests.has(requestId)) {
      return;
    }

    finished = true;
    onOutput({ type: 'error', text: 'Request timed out after 2 minutes.' });
    cancelAskAboutCode(requestId);
    onOutput({ type: 'done', exitCode: 1 });
  }, ASK_ABOUT_CODE_TIMEOUT_MS);
  activeTimers.set(requestId, timer);
}

export function resetAskAboutCodeState(): void {
  for (const requestId of Array.from(activeRequests.keys())) {
    cancelAskAboutCode(requestId);
  }

  for (const timer of activeTimers.values()) {
    clearTimeout(timer);
  }
  activeTimers.clear();
}
