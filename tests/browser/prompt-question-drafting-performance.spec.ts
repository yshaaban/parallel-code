import type { Locator, Page } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { createPromptQuestionScenario } from './harness/scenarios.js';

const KEY_TO_TEXT_P95_BUDGET_MS = 50;
const QUESTION_MODE_DELTA_BUDGET_MS = 5;
const SAMPLE_TEXT = 'abcdefghijklmnopqrstuvwxyzabcdef';
const NOISY_OUTPUT_COMMAND =
  'i=0; while [ "$i" -lt 1000 ]; do printf "\\rPROMPT_NOISE_%04d" "$i"; i=$((i+1)); sleep 0.01; done; printf "\\nPROMPT_NOISE_DONE\\n"';
const QUESTION_EXPLANATION =
  'Answer the question in the terminal; you can draft here while you work.';

type MeasurementPhase = 'baseline' | 'question';

interface PromptLatencyStore {
  keydownAtMs: number | null;
  phase: MeasurementPhase;
  samples: Record<MeasurementPhase, number[]>;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

async function installLatencyProbe(textarea: Locator): Promise<void> {
  await textarea.evaluate((element) => {
    const trackedWindow = window as typeof window & {
      __promptQuestionLatency?: PromptLatencyStore;
    };
    const store: PromptLatencyStore = {
      keydownAtMs: null,
      phase: 'baseline',
      samples: { baseline: [], question: [] },
    };
    trackedWindow.__promptQuestionLatency = store;

    element.addEventListener('keydown', (event) => {
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        store.keydownAtMs = performance.now();
      }
    });
    element.addEventListener('input', () => {
      const startedAtMs = store.keydownAtMs;
      if (startedAtMs === null) {
        return;
      }
      store.keydownAtMs = null;
      store.samples[store.phase].push(performance.now() - startedAtMs);
    });
  });
}

async function measurePhase(
  page: Page,
  textarea: Locator,
  phase: MeasurementPhase,
): Promise<number[]> {
  await textarea.fill('');
  await textarea.focus();
  await page.evaluate((nextPhase) => {
    const trackedWindow = window as typeof window & {
      __promptQuestionLatency?: PromptLatencyStore;
    };
    const store = trackedWindow.__promptQuestionLatency;
    if (!store) {
      throw new Error('Prompt latency probe was not installed');
    }
    store.keydownAtMs = null;
    store.phase = nextPhase;
    store.samples[nextPhase] = [];
  }, phase);

  for (const character of SAMPLE_TEXT) {
    const previousCount = await page.evaluate((currentPhase) => {
      const trackedWindow = window as typeof window & {
        __promptQuestionLatency?: PromptLatencyStore;
      };
      return trackedWindow.__promptQuestionLatency?.samples[currentPhase].length ?? -1;
    }, phase);
    expect(previousCount).toBeGreaterThanOrEqual(0);

    await Promise.all([
      page.waitForFunction(
        ({ currentPhase, expectedCount }) => {
          const trackedWindow = window as typeof window & {
            __promptQuestionLatency?: PromptLatencyStore;
          };
          return (
            (trackedWindow.__promptQuestionLatency?.samples[currentPhase].length ?? -1) ===
            expectedCount
          );
        },
        { currentPhase: phase, expectedCount: previousCount + 1 },
        { timeout: 1_000 },
      ),
      page.keyboard.press(character),
    ]);
  }

  return page.evaluate((currentPhase) => {
    const trackedWindow = window as typeof window & {
      __promptQuestionLatency?: PromptLatencyStore;
    };
    return [...(trackedWindow.__promptQuestionLatency?.samples[currentPhase] ?? [])];
  }, phase);
}

test.describe('prompt question drafting performance', () => {
  test.use({
    scenario: createPromptQuestionScenario(),
  });

  test('keeps key-to-text latency within budget under noisy visible output', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Prompt Latency',
    });

    await browserLab.waitForTerminalReady(page);
    const noisyTerminalIndex = await browserLab.createShellTerminal(page);
    const noisyAgentId =
      (await page
        .locator('[data-terminal-status]')
        .nth(noisyTerminalIndex)
        .getAttribute('data-terminal-agent-id')) ?? '';
    expect(noisyAgentId).not.toBe('');
    await browserLab.waitForShellPromptReady(request, noisyAgentId);
    await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
      terminalIndex: noisyTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, noisyAgentId, 'PROMPT_NOISE_');
    const textarea = page.locator('textarea.prompt-textarea');
    await expect(textarea).toBeVisible();
    await installLatencyProbe(textarea);
    const baselineSamples = await measurePhase(page, textarea, 'baseline');

    // Native focus now correctly leaves the noisy terminal and releases its typing intent.
    // This out-of-band fixture write must acquire control at the operation boundary, not
    // borrow a lease from before the user moved into the prompt editor.
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'type in the terminal',
    );
    await browserLab.invokeSessionIpc<undefined>(request, page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'question\r',
    });
    await expect(page.getByText(QUESTION_EXPLANATION)).toBeVisible();
    const questionSamples = await measurePhase(page, textarea, 'question');
    await browserLab.waitForAgentScrollback(request, noisyAgentId, 'PROMPT_NOISE_0100');

    const baselineP95Ms = percentile(baselineSamples, 0.95);
    const questionP95Ms = percentile(questionSamples, 0.95);
    const questionDeltaMs = questionP95Ms - baselineP95Ms;

    process.stdout.write(
      `${[
        'prompt-question-key-to-text',
        `samples=${baselineSamples.length + questionSamples.length}`,
        `baselineP95=${baselineP95Ms.toFixed(3)}ms`,
        `questionP95=${questionP95Ms.toFixed(3)}ms`,
        `delta=${questionDeltaMs.toFixed(3)}ms`,
        `p95Budget=${KEY_TO_TEXT_P95_BUDGET_MS}ms`,
        `deltaBudget=${QUESTION_MODE_DELTA_BUDGET_MS}ms`,
      ].join(' ')}\n`,
    );

    expect(baselineSamples).toHaveLength(SAMPLE_TEXT.length);
    expect(questionSamples).toHaveLength(SAMPLE_TEXT.length);
    expect(baselineP95Ms).toBeLessThan(KEY_TO_TEXT_P95_BUDGET_MS);
    expect(questionP95Ms).toBeLessThan(KEY_TO_TEXT_P95_BUDGET_MS);
    expect(questionDeltaMs).toBeLessThanOrEqual(QUESTION_MODE_DELTA_BUDGET_MS);
  });
});
