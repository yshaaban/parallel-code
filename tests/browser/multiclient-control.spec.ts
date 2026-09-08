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

  test('restores an absent auxiliary shell only after explicit task-control approval', async ({
    browser,
    browserLab,
    request,
  }) => {
    const owner = await browserLab.openSession(browser, {
      clientId: 'shell-restore-owner',
      displayName: 'Ivan',
    });
    await browserLab.waitForTerminalReady(owner.page);
    await owner.page.getByTitle(/^Open terminal /u).click();
    const shell = owner.page.locator(
      `[data-terminal-agent-id]:not([data-terminal-agent-id="${browserLab.server.agentId}"])`,
    );
    await expect(shell).toHaveAttribute('data-terminal-status', 'ready');
    const shellId = await shell.getAttribute('data-terminal-agent-id');
    if (!shellId) throw new Error('Expected an exact auxiliary shell identity');
    await expect
      .poll(async () => {
        const state = await browserLab.invokeIpc<{ json: string }>(request, IPC.LoadWorkspaceState);
        const workspace = JSON.parse(state.json) as {
          tasks: Record<string, { shellAgentIds: string[] }>;
        };
        return workspace.tasks[browserLab.server.taskId]?.shellAgentIds;
      })
      .toEqual([shellId]);

    // Close/maximize controls must both remain reachable in the same shell pane.
    const close = owner.page.getByTitle('Close terminal (Ctrl+Shift+Q)');
    await shell.hover();
    await close.click({ trial: true });
    await shell.getByRole('button', { name: 'Maximize terminal' }).click();
    await expect(shell).toHaveAttribute('data-terminal-maximized', 'true');
    await shell.getByRole('button', { name: 'Restore terminal' }).click();
    await shell.hover();
    await close.click({ trial: true });

    await browserLab.retainSessionTaskCommandLease(
      request,
      owner.page,
      browserLab.server.taskId,
      'inspect shell recovery',
    );
    await browserLab.invokeSessionIpc(request, owner.page, IPC.KillAgent, { agentId: shellId });
    await expect
      .poll(async () =>
        (await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds)).includes(shellId),
      )
      .toBe(false);

    const observer = await browserLab.openSession(browser, {
      clientId: 'shell-restore-observer',
      displayName: 'Sara',
    });
    const restoredShell = observer.page.locator(`[data-terminal-agent-id="${shellId}"]`);
    const blocked = restoredShell.locator(
      '[data-terminal-restore-unavailable="task-control-unavailable"]',
    );
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('Task control is required');
    expect(
      (await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds)).includes(shellId),
    ).toBe(false);
    await expect(owner.page.getByText('Allow takeover?')).toHaveCount(0);

    await blocked.getByRole('button', { name: 'Restore terminal' }).click();
    await expect(owner.page.getByText('Allow takeover?')).toBeVisible();
    await owner.page.getByRole('button', { name: 'Keep Control' }).click();
    await expect(blocked).toBeVisible();
    expect(
      (await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds)).includes(shellId),
    ).toBe(false);

    await blocked.getByRole('button', { name: 'Restore terminal' }).click();
    await expect(owner.page.getByText('Allow takeover?')).toBeVisible();
    await owner.page.getByRole('button', { name: 'Allow' }).click();
    await expect(restoredShell).toHaveAttribute('data-terminal-status', 'ready');
    await expect(restoredShell).toHaveAttribute('data-terminal-agent-id', shellId);
    const running = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
    expect(running.filter((id) => id === shellId)).toHaveLength(1);
    expect(running).toContain(browserLab.server.agentId);
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

    await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner',
      ownerId: 'browser-lab-owner-runtime',
      taskId: browserLab.server.taskId,
    });
    await browserLab.beginTerminalStatusHistory(observerSession.page);

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

    await browserLab.invokeSessionIpc(request, observerSession.page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'console.log("TAKEOVER_MARKER")\r',
    });
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

    await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.AcquireTaskCommandLease, {
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
    const ownerName = 'Ivan with a long collaborator name';
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-owner-blocked',
      displayName: ownerName,
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'browser-lab-observer-blocked',
      displayName: 'Sara',
    });

    await browserLab.waitForTerminalReady(ownerSession.page);
    await browserLab.waitForTerminalReady(observerSession.page);
    await observerSession.page.setViewportSize({ width: 960, height: 720 });

    await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'browser-lab-owner-blocked',
      ownerId: 'browser-lab-owner-blocked-runtime',
      taskId: browserLab.server.taskId,
    });
    await browserLab.beginTerminalStatusHistory(observerSession.page);

    const blockedMarker = 'BLOCKED_BEFORE_TAKEOVER';
    await browserLab.typeInTerminal(observerSession.page, `console.log("${blockedMarker}")`, {
      requireInteractiveReady: false,
    });
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

    const terminal = observerSession.page.locator(
      `[data-terminal-agent-id="${browserLab.server.agentId}"]`,
    );
    const notice = terminal.locator('.task-control-notice');
    await expect(notice.getByRole('status')).toHaveText(
      `${ownerName} is currently typing in this terminal.`,
    );
    const bannerGeometry = await notice.evaluate((element) => {
      const button = element.querySelector('button:last-child');
      if (!button) throw new Error('Expected a takeover action in the control notice');
      const bounds = element.getBoundingClientRect();
      return {
        height: bounds.height,
        buttonHeight: button.getBoundingClientRect().height,
        fits: element.scrollWidth <= element.clientWidth,
        shadow: getComputedStyle(element).boxShadow,
      };
    });
    expect(bannerGeometry.height).toBeLessThanOrEqual(28.5);
    expect(bannerGeometry.buttonHeight).toBe(24);
    expect(bannerGeometry.fits).toBe(true);
    expect(bannerGeometry.shadow).toBe('none');
    await test.info().attach('compact-terminal-control-notice', {
      body: await terminal.screenshot(),
      contentType: 'image/png',
    });
    await notice.getByRole('button', { name: 'Dismiss control notice' }).focus();
    await observerSession.page.keyboard.press('Enter');
    await expect(notice.getByRole('status')).toHaveText(`${ownerName} typing`);
    expect(await notice.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      bannerGeometry.height,
    );
    await expect(notice.getByRole('button', { name: 'Take Over' })).toBeInViewport();

    await observerSession.page.getByRole('button', { name: /^Take Over$/u }).click();
    await expect(ownerSession.page.getByText('Allow takeover?')).toBeVisible();
    await ownerSession.page.getByRole('button', { name: 'Allow' }).click();

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
          controllerId: 'browser-lab-observer-blocked',
          taskId: browserLab.server.taskId,
        },
      ]);
    await expect(observerSession.page.getByText(`${ownerName} typing`)).toHaveCount(0);

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

    await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.AcquireTaskCommandLease, {
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
