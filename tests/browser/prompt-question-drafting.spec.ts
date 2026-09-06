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
    const sendFixtureCommand = async (command: string): Promise<void> => {
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        browserLab.server.agentId,
        'type in the terminal',
      );
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

  test('keeps keyboard-entered prompt focus and draft through a real reconnect', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Keyboard Prompt Recovery',
      prepareContext: async (browserContext) => {
        await browserContext.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const textarea = page.locator('textarea.prompt-textarea');
      await textarea.fill('Draft before reconnect');
      await browserLab.focusTerminal(page);
      await page.evaluate(() => {
        const transport = window.__parallelCodeBrowserTransportForTests__;
        if (!transport) throw new Error('Browser transport hook is unavailable');
        transport.disconnect();
      });
      await expect
        .poll(() => browserLab.readConnectionBannerHistory(page))
        .toContain('disconnected');

      // Move through a real keyboard tab stop, without clicking the prompt panel.
      const sendButton = page.getByTitle('Send prompt');
      await sendButton.focus();
      await expect(sendButton).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(textarea).toBeFocused();
      await page.keyboard.type(' while offline');

      await page.evaluate(() => {
        const transport = window.__parallelCodeBrowserTransportForTests__;
        if (!transport) throw new Error('Browser transport hook is unavailable');
        return transport.ensureConnected();
      });
      await browserLab.waitForTerminalReady(page);
      await expect
        .poll(async () => (await browserLab.readConnectionBannerHistory(page)).at(-1))
        .toBeNull();
      await expect(textarea).toBeFocused();
      await page.keyboard.type(' after reconnect');
      await expect(textarea).toHaveValue('Draft before reconnect while offline after reconnect');
    } finally {
      await context.close();
    }
  });
});
