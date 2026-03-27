import { expect, test } from './harness/fixtures.js';
import {
  assertInteractiveTerminalLifecycleInvariants,
  assertTerminalLifecycleInvariants,
} from './harness/lifecycle-invariants.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';
import {
  dragTerminalPanelResizeHandle,
  getRendererDiagnostics,
} from './harness/terminal-render.js';
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
      ownerId: 'browser-lab-owner-runtime',
      taskId: browserLab.server.taskId,
    });

    await browserLab.typeInTerminal(ownerSession.page, 'console.log("OWNER_MARKER")');
    await ownerSession.page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'OWNER_MARKER');
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      ownerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-owner',
        requireDocumentFocus: true,
      },
    );

    await observerSession.page.reload();
    await observerSession.page.locator('.app-shell').waitFor({ state: 'visible' });
    await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();
    await assertTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-owner',
        requireCursorBlink: false,
      },
    );

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
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-observer',
        requireDocumentFocus: true,
      },
    );

    await expect(ownerSession.page.getByText('Sara typing').first()).toBeVisible();
    await assertTerminalLifecycleInvariants(
      browserLab,
      request,
      ownerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-observer',
        requireCursorBlink: false,
      },
    );
  });

  test('keeps control-state truth aligned across repeated observer reloads before takeover', async ({
    browser,
    browserLab,
    request,
  }) => {
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-owner-loop',
      displayName: 'Ivan',
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-observer-loop',
      displayName: 'Sara',
    });

    await browserLab.waitForTerminalReady(ownerSession.page);
    await browserLab.waitForTerminalReady(observerSession.page);

    await browserLab.invokeIpc(request, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner-loop',
      ownerId: 'browser-lab-owner-loop-runtime',
      taskId: browserLab.server.taskId,
    });

    for (const cycle of [1, 2, 3]) {
      await ownerSession.page.bringToFront();
      await browserLab.typeInTerminal(ownerSession.page, `console.log("OWNER_LOOP_${cycle}")`);
      await ownerSession.page.keyboard.press('Enter');
      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        `OWNER_LOOP_${cycle}`,
      );
      await assertInteractiveTerminalLifecycleInvariants(
        browserLab,
        request,
        ownerSession.page,
        browserLab.server.taskId,
        {
          expectedControllerId: 'browser-lab-owner-loop',
          requireDocumentFocus: true,
        },
      );

      await observerSession.page.reload();
      await observerSession.page.locator('.app-shell').waitFor({ state: 'visible' });
      await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();
      await assertTerminalLifecycleInvariants(
        browserLab,
        request,
        observerSession.page,
        browserLab.server.taskId,
        {
          expectedControllerId: 'browser-lab-owner-loop',
          requireCursorBlink: false,
        },
      );
    }

    await observerSession.page.getByRole('button', { name: /^Take Over$/u }).click();
    await expect(ownerSession.page.getByText('Allow takeover?')).toBeVisible();
    await ownerSession.page.getByRole('button', { name: 'Allow' }).click();
    await expect(observerSession.page.getByText('Ivan typing')).toHaveCount(0);
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-observer-loop',
      },
    );
  });

  test('blocks observer terminal input until takeover is approved, then resumes cleanly', async ({
    browser,
    browserLab,
    request,
  }) => {
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-owner-blocked',
      displayName: 'Ivan',
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-observer-blocked',
      displayName: 'Sara',
    });

    await browserLab.waitForTerminalReady(ownerSession.page);
    await browserLab.waitForTerminalReady(observerSession.page);

    await browserLab.invokeIpc(request, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner-blocked',
      ownerId: 'browser-lab-owner-blocked-runtime',
      taskId: browserLab.server.taskId,
    });

    const blockedMarker = 'BLOCKED_BEFORE_TAKEOVER';
    await browserLab.typeInTerminal(observerSession.page, `console.log("${blockedMarker}")`);
    await observerSession.page.keyboard.press('Enter');
    await observerSession.page.waitForTimeout(250);
    const scrollbackBeforeTakeover = await browserLab.invokeIpc<string>(
      request,
      IPC.GetAgentScrollback,
      {
        agentId: browserLab.server.agentId,
      },
    );
    expect(Buffer.from(scrollbackBeforeTakeover, 'base64').toString('utf8')).not.toContain(
      blockedMarker,
    );
    await assertTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-owner-blocked',
        requireCursorBlink: false,
      },
    );

    await observerSession.page.getByRole('button', { name: /^Take Over$/u }).click();
    await expect(ownerSession.page.getByText('Allow takeover?')).toBeVisible();
    await ownerSession.page.getByRole('button', { name: 'Allow' }).click();

    const approvedMarker = 'ALLOWED_AFTER_TAKEOVER';
    await browserLab.typeInTerminal(observerSession.page, `console.log("${approvedMarker}")`);
    await observerSession.page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, approvedMarker);
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-observer-blocked',
        requireDocumentFocus: true,
      },
    );
  });

  test('defers observer resize commits while peer-controlled and commits them after takeover', async ({
    browser,
    browserLab,
    request,
  }) => {
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-owner-resize',
      displayName: 'Ivan',
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-observer-resize',
      displayName: 'Sara',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    await browserLab.waitForTerminalReady(ownerSession.page);
    await browserLab.waitForTerminalReady(observerSession.page);

    await browserLab.invokeIpc(request, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner-resize',
      ownerId: 'browser-lab-owner-resize-runtime',
      taskId: browserLab.server.taskId,
    });

    await observerSession.page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
    });
    await dragTerminalPanelResizeHandle(observerSession.page, 0, 100);
    await observerSession.page.waitForTimeout(200);

    await observerSession.page.getByRole('button', { name: /^Take Over$/u }).click();
    await expect(ownerSession.page.getByText('Allow takeover?')).toBeVisible();
    await ownerSession.page.getByRole('button', { name: 'Allow' }).click();

    await dragTerminalPanelResizeHandle(observerSession.page, 0, -80);
    await browserLab.typeInTerminal(observerSession.page, 'console.log("RESIZE_AFTER_TAKEOVER")');
    await observerSession.page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESIZE_AFTER_TAKEOVER',
    );

    const rendererDiagnostics = await getRendererDiagnostics(observerSession.page);
    expect(
      rendererDiagnostics?.terminalResize.commitDeferredCounts['peer-controlled'] ?? 0,
    ).toBeGreaterThan(0);
    expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      observerSession.page,
      browserLab.server.taskId,
      {
        expectedControllerId: 'browser-lab-observer-resize',
        requireDocumentFocus: true,
      },
    );
  });
});
