import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { classifyOutputState } from '../../electron/ipc/agent-supervision-parser.js';
import {
  reduceTaskInitialPromptDelivery,
  type TaskInitialPromptDeliverySnapshot,
} from '../../src/domain/task-initial-prompt-delivery.js';
import { classifyPromptDeliveryEvidence } from '../../src/lib/prompt-delivery-readiness.js';
import {
  createPersistentPromptReadyScenario,
  createPromptReadyScenario,
} from '../browser/harness/scenarios.js';

const execFileAsync = promisify(execFile);
const QUESTION_FIXTURE_PATH = path.resolve('scripts/fixtures/tui-prompt-question.mjs');

function countReadyPrompts(output: string): number {
  return output.match(/❯ /gu)?.length ?? 0;
}

function waitForReadyPromptCount(
  child: ChildProcessWithoutNullStreams,
  readOutput: () => string,
  expectedCount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedCount} fixture prompts`));
    }, 2_000);
    const onData = () => {
      const output = readOutput();
      if (countReadyPrompts(output) >= expectedCount) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Prompt fixture exited before redraw (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData();
  });
}

function waitForOutputFragment(
  child: ChildProcessWithoutNullStreams,
  readOutput: () => string,
  fragment: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for fixture output ${JSON.stringify(fragment)}`));
    }, 2_000);
    const onData = () => {
      const output = readOutput();
      if (output.includes(fragment)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Prompt fixture exited before output (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData();
  });
}

describe('prompt-ready browser fixture', () => {
  it('emits evidence accepted by supervision and managed prompt delivery', async () => {
    const { agentDef } = createPromptReadyScenario(0);
    const { stdout } = await execFileAsync(agentDef.command, agentDef.args);

    expect(classifyOutputState(stdout).state).toBe('idle-at-prompt');

    const first = classifyPromptDeliveryEvidence({
      generation: 0,
      lastOutputAtMs: 0,
      nowMs: 1_000,
      supervisionState: 'idle-at-prompt',
      tail: stdout,
    });
    expect(first.readyCandidate).toBeDefined();

    expect(
      classifyPromptDeliveryEvidence({
        generation: 0,
        lastOutputAtMs: 0,
        nowMs: 2_000,
        previousReadyCandidate: first.readyCandidate,
        supervisionState: 'idle-at-prompt',
        tail: stdout,
      }).kind,
    ).toBe('ready');
  });

  it('redraws a trusted prompt after a persistent input line and supplies delivery evidence', async () => {
    const { agentDef } = createPersistentPromptReadyScenario(0);
    const child = spawn(agentDef.command, agentDef.args);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      const initialOutput = await waitForReadyPromptCount(child, () => stdout, 1);
      const prompt = 'Verify the persistent fixture cycle';
      const redrawnOutputPromise = waitForReadyPromptCount(child, () => stdout, 2);
      child.stdin.write(`${prompt}\r`);
      const redrawnOutput = await redrawnOutputPromise;

      expect(stderr).toBe('');
      expect(redrawnOutput.slice(initialOutput.length)).toContain('\r\n❯ ');
      expect(classifyOutputState(redrawnOutput).state).toBe('idle-at-prompt');

      const evidence = classifyPromptDeliveryEvidence({
        generation: 0,
        lastOutputAtMs: 2_001,
        nowMs: 2_002,
        postWrite: {
          activityTransitionObserved: true,
          promptPrefix: prompt,
          returnedToReadySnapshot: true,
        },
        supervisionState: 'idle-at-prompt',
        tail: redrawnOutput,
      });
      expect(evidence.kind).toBe('delivered');

      const verifying: TaskInitialPromptDeliverySnapshot = {
        agentId: 'fixture-agent',
        attempts: 1,
        createdAt: '2026-08-04T00:00:00.000Z',
        deliveryId: 'fixture-delivery',
        status: 'verifying',
        targetGeneration: 0,
        taskId: 'fixture-task',
        updatedAt: '2026-08-04T00:00:02.000Z',
        version: 4,
      };
      expect(
        reduceTaskInitialPromptDelivery(
          verifying,
          { kind: 'evidence-delivered' },
          '2026-08-04T00:00:02.002Z',
        ),
      ).toMatchObject({ kind: 'transitioned', snapshot: { status: 'delivered' } });
    } finally {
      child.kill();
    }
  });
});

describe('prompt-question browser fixture', () => {
  it('redraws trusted prompt evidence that clears an answered question', async () => {
    const child = spawn(process.execPath, [QUESTION_FIXTURE_PATH]);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForOutputFragment(child, () => stdout, 'fixture> ');
      child.stdin.write('question\r');
      const questionOutput = await waitForOutputFragment(
        child,
        () => stdout,
        'Would you like to continue? [Y/n]',
      );
      expect(classifyOutputState(questionOutput).state).toBe('awaiting-input');

      child.stdin.write('yes\r');
      const answeredOutput = await waitForReadyPromptCount(child, () => stdout, 1);

      expect(stderr).toBe('');
      expect(answeredOutput).toContain('answer accepted');
      expect(classifyOutputState(answeredOutput).state).toBe('idle-at-prompt');
    } finally {
      child.kill();
    }
  });
});
