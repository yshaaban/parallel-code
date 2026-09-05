import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

function getRemoteAgentCardName(taskName: string): RegExp {
  return new RegExp(`^Open ${taskName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
}

test.describe('browser-lab remote bootstrap', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('renders the remote shell from a tokenized link', async ({
    browser,
    browserLab,
    scenario,
  }) => {
    const seededSession = await browserLab.openSession(browser, {
      displayName: 'Remote Bootstrap Seeder',
    });
    await browserLab.waitForTerminalReady(seededSession.page);

    const remoteContext = await browser.newContext();
    const remotePage = await remoteContext.newPage();
    let sawRemoteWebSocket = false;

    remotePage.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname === '/ws') {
        sawRemoteWebSocket = true;
      }
    });

    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'networkidle',
    });

    await expect(remotePage).toHaveURL(/\/remote\/$/u);
    await expect(
      remotePage.getByRole('button', { name: getRemoteAgentCardName(scenario.taskName) }),
    ).toBeVisible();
    await expect(remotePage.getByText('Not authenticated')).toHaveCount(0);
    await expect.poll(() => sawRemoteWebSocket).toBe(true);

    await remoteContext.close();
    await seededSession.context.close();
  });

  test('preserves remote keyboard focus and static content under accessibility preferences', async ({
    browser,
    browserLab,
    scenario,
  }) => {
    const seededSession = await browserLab.openSession(browser, {
      displayName: 'Remote Accessibility Seeder',
    });
    await browserLab.waitForTerminalReady(seededSession.page);

    const remoteContext = await browser.newContext({
      forcedColors: 'active',
      reducedMotion: 'reduce',
    });
    const remotePage = await remoteContext.newPage();

    try {
      await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
        waitUntil: 'networkidle',
      });
      const taskCard = remotePage.getByRole('button', {
        name: getRemoteAgentCardName(scenario.taskName),
      });
      await expect(taskCard).toBeVisible();

      await taskCard.evaluate((element) => (element as HTMLElement).blur());
      for (let index = 0; index < 40; index += 1) {
        await remotePage.keyboard.press('Tab');
        if (await taskCard.evaluate((element) => element === document.activeElement)) {
          break;
        }
      }
      await expect(taskCard).toBeFocused();

      const evidence = await taskCard.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          forcedColors: matchMedia('(forced-colors: active)').matches,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
          transitionDurationSeconds: style.transitionDuration
            .split(',')
            .map((duration) => Number.parseFloat(duration)),
        };
      });
      expect(evidence.forcedColors).toBe(true);
      expect(evidence.reducedMotion).toBe(true);
      expect(evidence.outlineStyle).toBe('solid');
      expect(evidence.outlineWidth).toBeGreaterThanOrEqual(2);
      expect(evidence.transitionDurationSeconds).toContain(0.00001);
      await expect(taskCard).toContainText(scenario.taskName);
    } finally {
      await remoteContext.close();
      await seededSession.context.close();
    }
  });
});
