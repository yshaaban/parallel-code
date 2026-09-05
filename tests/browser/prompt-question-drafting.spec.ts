import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { createPromptQuestionScenario } from './harness/scenarios.js';

const QUESTION_EXPLANATION =
  'Answer the question in the terminal; you can draft here while you work.';

test.describe('prompt question drafting and focus', () => {
  test.use({
    scenario: createPromptQuestionScenario(),
  });

  test('preserves real focus and the draft across question enter, exit, and terminal interaction', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Prompt Drafter',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          const trackedWindow = window as typeof window & {
            __promptQuestionFocusCalls?: string[];
          };
          trackedWindow.__promptQuestionFocusCalls = [];
          const originalFocus = HTMLElement.prototype.focus;
          HTMLElement.prototype.focus = function trackedFocus(options?: FocusOptions): void {
            trackedWindow.__promptQuestionFocusCalls?.push(
              `${this.tagName.toLowerCase()}.${this.className}`,
            );
            originalFocus.call(this, options);
          };
        });
      },
    });

    await browserLab.waitForTerminalReady(page);
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'fixture>');
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'type in the terminal',
    );
    const sendFixtureCommand = async (command: string): Promise<void> => {
      await browserLab.invokeSessionIpc<undefined>(request, page, IPC.WriteToAgent, {
        agentId: browserLab.server.agentId,
        data: `${command}\r`,
      });
    };

    const textarea = page.locator('textarea.prompt-textarea');
    const sendButton = page.getByTitle('Send prompt');
    await expect(textarea).toBeVisible();
    await textarea.fill('draft before question');
    await textarea.focus();
    await page.evaluate(() => {
      const trackedWindow = window as typeof window & {
        __promptQuestionFocusCalls?: string[];
      };
      trackedWindow.__promptQuestionFocusCalls = [];
    });

    await sendFixtureCommand('question');
    await expect(page.getByText(QUESTION_EXPLANATION)).toBeVisible();
    await expect(sendButton).toBeDisabled();
    await expect
      .poll(() => textarea.evaluate((element) => document.activeElement === element))
      .toBe(true);

    await page.keyboard.type(' plus answer');
    await page.keyboard.press('Enter');
    await page.keyboard.type('continued');
    await expect(textarea).toHaveValue('draft before question plus answer\ncontinued');
    await expect(sendButton).toBeDisabled();

    await sendFixtureCommand('yes');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'answer accepted');
    await expect(page.getByText(QUESTION_EXPLANATION)).toHaveCount(0);
    await expect(sendButton).toBeEnabled();
    await expect
      .poll(() => textarea.evaluate((element) => document.activeElement === element))
      .toBe(true);
    const focusCalls = await page.evaluate(() => {
      const trackedWindow = window as typeof window & {
        __promptQuestionFocusCalls?: string[];
      };
      return [...(trackedWindow.__promptQuestionFocusCalls ?? [])];
    });
    expect(focusCalls).toEqual([]);

    await sendFixtureCommand('question');
    await expect(page.getByText(QUESTION_EXPLANATION)).toBeVisible();
    await browserLab.focusTerminal(page);
    await page.keyboard.type('yes');
    await page.keyboard.press('Enter');
    await expect(page.getByText(QUESTION_EXPLANATION)).toHaveCount(0);
    await expect(sendButton).toBeEnabled();
    await expect(textarea).toHaveValue('draft before question plus answer\ncontinued');
  });
});
