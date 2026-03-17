import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';
import { IPC } from '../../electron/ipc/channels.js';

test.describe('browser-lab multiclient terminal control', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('shows read-only ownership and hands control over after approval', async ({
    browser,
    browserLab,
    request,
  }) => {
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-owner',
      displayName: 'Ivan',
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-observer',
      displayName: 'Sara',
    });

    await browserLab.waitForTerminalReady(ownerSession.page);
    await browserLab.waitForTerminalReady(observerSession.page);

    await browserLab.invokeIpc(request, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner',
      taskId: browserLab.server.taskId,
    });

    await browserLab.typeInTerminal(ownerSession.page, 'console.log("OWNER_MARKER")');
    await ownerSession.page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'OWNER_MARKER');

    await observerSession.page.reload();
    await observerSession.page.locator('.app-shell').waitFor({ state: 'visible' });
    await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();

    await observerSession.page.getByRole('button', { name: /^Take Over$/u }).click();

    await expect(ownerSession.page.getByText('Allow takeover?')).toBeVisible();
    await expect(ownerSession.page.getByText(/Sara wants to take control/u)).toBeVisible();
    await ownerSession.page.getByRole('button', { name: 'Allow' }).click();

    await expect(observerSession.page.getByText('Ivan typing')).toHaveCount(0);
    await expect(observerSession.page.getByText('You typing').first()).toBeVisible();
    await expect
      .poll(async () => {
        const result = await browserLab.invokeIpc(request, IPC.GetTaskCommandControllers);
        return result.controllers.map((controller) => ({
          action: controller.action,
          controllerId: controller.controllerId,
          taskId: controller.taskId,
        }));
      })
      .toEqual([
        {
          action: 'type in the terminal',
          controllerId: 'browser-lab-observer',
          taskId: browserLab.server.taskId,
        },
      ]);

    await browserLab.typeInTerminal(observerSession.page, 'console.log("TAKEOVER_MARKER")');
    await observerSession.page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'TAKEOVER_MARKER');

    await expect(ownerSession.page.getByText('Sara typing').first()).toBeVisible();
  });
});
