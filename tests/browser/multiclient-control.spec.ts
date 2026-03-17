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
        return browserLab.invokeIpc(request, IPC.GetTaskCommandControllers);
      })
      .toEqual([
        {
          action: 'type in the terminal',
          controllerId: 'browser-lab-observer',
          taskId: browserLab.server.taskId,
        },
      ]);

    await browserLab.invokeIpc(request, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      controllerId: 'browser-lab-observer',
      data: 'console.log("TAKEOVER_MARKER")\n',
      taskId: browserLab.server.taskId,
    });
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'TAKEOVER_MARKER');

    await expect(ownerSession.page.getByText('Sara typing').first()).toBeVisible();
  });
});
