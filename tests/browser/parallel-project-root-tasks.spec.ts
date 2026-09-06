import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const rootBranch = 'integration/trunk';
const sentinelName = 'shared-root-sentinel.txt';
const sharedRootTitle = /Works directly in the project root; shares files and Git state/;

test.use({
  scenario: {
    ...createInteractiveNodeScenario(),
    name: 'parallel-project-root-tasks',
    taskGitIsolation: 'current-branch',
    taskName: 'Existing root agent',
    seedRepo: async (repoDir) => {
      // The harness project still records main as its default. Root creation must not depend on
      // that obsolete default or switch this dirty, custom-named checkout underneath the agent.
      execFileSync('git', ['branch', '-m', rootBranch], { cwd: repoDir });
      await writeFile(path.join(repoDir, sentinelName), 'Keep shared root files\n', 'utf8');
    },
  },
});

for (const mode of ['terminal', 'agent'] as const) {
  test(`reopens a canonical root ${mode} repeatedly and across reload without stopping its sibling`, async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await browserLab.openSession(browser, {
      displayName: `Root ${mode} continuity`,
    });
    try {
      await browserLab.waitForActiveTerminalInteractiveReady(page);
      // This REPL state disappears if collapsing the other task kills a shared-root sibling.
      await browserLab.runInTerminal(page, "globalThis.rootSiblingState = 'PRESERVED'");
      const sidecarId = browserLab.server.agentId;
      const name = `Reopen root ${mode}`;
      await page
        .locator('button')
        .filter({ hasText: /^New Task$/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      await dialog
        .getByRole('button', { name: mode === 'terminal' ? 'Terminal' : 'Agent', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Project root', exact: true }).click();
      await dialog.locator('[data-nav-field="task-name"] input').fill(name);
      if (mode === 'agent') {
        await dialog.getByRole('button', { name: /Browser Lab Node REPL/ }).click();
      }
      await dialog
        .getByRole('button', {
          name: mode === 'terminal' ? 'Create Terminal Task' : 'Create Task',
          exact: true,
        })
        .click();
      await expect(dialog).toHaveCount(0);
      const panel = page
        .locator('[data-task-id]')
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(panel).toBeVisible();
      await browserLab.waitForActiveTerminalInteractiveReady(page, { timeoutMs: 15_000 });
      const taskId = await panel.getAttribute('data-task-id');
      const sessionId = await panel
        .locator('[data-terminal-agent-id]')
        .first()
        .getAttribute('data-terminal-agent-id');
      if (!taskId || !sessionId) throw new Error('Created root task is missing canonical identity');

      type CanonicalTask = {
        agentId?: string;
        agentIds?: string[];
        shellAgentIds: string[];
        collapsed?: boolean;
        taskInitialShellOwnership?: { sessionId: string };
      };
      const readTask = async (): Promise<
        CanonicalTask & { agentIds: string[]; primaryAgentId: string | null }
      > => {
        const workspace = await browserLab.invokeIpc<{ json: string }>(
          request,
          IPC.LoadWorkspaceState,
        );
        const state = JSON.parse(workspace.json) as { tasks: Record<string, CanonicalTask> };
        const task = state.tasks[taskId];
        if (!task) throw new Error('Canonical task disappeared');
        // Creation writes an array; the canonical serializer compacts a single agent to
        // agentId. Compare the exact identity and order, not that representational choice.
        const agentIds = task.agentIds?.length ? task.agentIds : task.agentId ? [task.agentId] : [];
        return { ...task, agentIds, primaryAgentId: task.agentId ?? agentIds[0] ?? null };
      };
      const original = await readTask();
      expect(mode === 'terminal' ? original.shellAgentIds : original.agentIds).toContain(sessionId);
      const assertUsable = async (suffix: string): Promise<void> => {
        await panel.getByTitle(sharedRootTitle).first().click();
        await browserLab.waitForActiveTerminalInteractiveReady(page, { timeoutMs: 15_000 });
        await expect(panel.locator('[data-terminal-agent-id]').first()).toHaveAttribute(
          'data-terminal-agent-id',
          sessionId,
        );
        const input = panel.locator('textarea[aria-label="Terminal input"]').first();
        await input.focus();
        const prefix = mode === 'terminal' ? 'TERMINAL_' : 'AGENT_';
        const command =
          mode === 'terminal'
            ? `printf '${prefix}%s\\n' '${suffix}'`
            : `console.log('${prefix}' + '${suffix}')`;
        await input.pressSequentially(command, { delay: 10 });
        await input.press('Enter');
        await browserLab.waitForAgentScrollback(request, sessionId, `${prefix}${suffix}`);
      };

      for (const cycle of [1, 2]) {
        await panel.getByTitle('Collapse task', { exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect
          .poll(() => browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds))
          .not.toContain(sessionId);
        expect(await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds)).toContain(
          sidecarId,
        );
        const collapsed = await readTask();
        expect(collapsed.collapsed).toBe(true);
        expect(collapsed.agentIds).toEqual(original.agentIds);
        expect(collapsed.primaryAgentId).toBe(original.primaryAgentId);
        expect(collapsed.shellAgentIds).toEqual(original.shellAgentIds);
        expect(collapsed.taskInitialShellOwnership).toEqual(original.taskInitialShellOwnership);

        if (cycle === 1) {
          await page.reload();
          await expect(panel).toHaveCount(0);
        }
        const restore = page.locator(
          `[data-sidebar-task-id="${taskId}"][title="Click to restore"]`,
        );
        await expect(restore).toBeVisible();
        await restore.click();
        await expect(panel).toBeVisible();
        await assertUsable(`REOPEN_${cycle}`);
      }

      await page.reload();
      await expect(panel).toBeVisible();
      await assertUsable('AFTER_RELOAD');
      const sidecar = page.locator(`[data-task-id="${browserLab.server.taskId}"]`);
      await sidecar.getByTitle(sharedRootTitle).first().click();
      await browserLab.waitForActiveTerminalInteractiveReady(page);
      const sidecarInput = sidecar.locator('textarea[aria-label="Terminal input"]').first();
      await sidecarInput.focus();
      await sidecarInput.pressSequentially(
        "console.log('SIDECAR_' + globalThis.rootSiblingState)",
        { delay: 10 },
      );
      await sidecarInput.press('Enter');
      await browserLab.waitForAgentScrollback(request, sidecarId, 'SIDECAR_PRESERVED');
      expect(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: browserLab.server.repoDir,
          encoding: 'utf8',
        }).trim(),
      ).toBe(rootBranch);
      expect(await readFile(path.join(browserLab.server.repoDir, sentinelName), 'utf8')).toBe(
        'Keep shared root files\n',
      );
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
    } catch (error) {
      const lifecycle = await browserLab.readLifecycleSnapshot(page);
      await test.info().attach('root-recovery-before-close.json', {
        body: JSON.stringify({ page: lifecycle.page, serverStderr: lifecycle.server.stderrTail }),
        contentType: 'application/json',
      });
      throw error;
    } finally {
      await context.close();
    }
  });
}

test('creates parallel root terminals on a custom branch and closes one without disrupting its sibling', async ({
  browser,
  browserLab,
  request,
}) => {
  const { context, page } = await browserLab.openSession(browser, {
    displayName: 'Parallel root tasks',
  });
  try {
    await browserLab.waitForActiveTerminalInteractiveReady(page);
    const createRootTerminal = async (name: string): Promise<string> => {
      await page
        .locator('button')
        .filter({ hasText: /^New Task$/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      await dialog.getByRole('button', { name: 'Terminal', exact: true }).click();
      await dialog.getByRole('button', { name: 'Project root', exact: true }).click();
      await dialog.locator('[data-nav-field="task-name"] input').fill(name);
      await expect(
        dialog.getByText(/Uses the checked-out branch without switching it/),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Create Terminal Task', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const panel = page.locator('[data-task-id]').filter({
        has: page.getByText(name, { exact: true }),
      });
      await expect(panel).toBeVisible();
      await expect(panel.getByTitle(sharedRootTitle).first()).toBeVisible();
      await browserLab.waitForActiveTerminalInteractiveReady(page, { timeoutMs: 15_000 });
      const taskId = await panel.getAttribute('data-task-id');
      if (!taskId) throw new Error('Created root task has no task identity');
      return taskId;
    };

    const firstTaskId = await createRootTerminal('Shared root terminal one');
    const secondTaskId = await createRootTerminal('Shared root terminal two');
    expect(firstTaskId).not.toBe(secondTaskId);
    const firstPanel = page.locator(`[data-task-id="${firstTaskId}"]`);
    const secondPanel = page.locator(`[data-task-id="${secondTaskId}"]`);
    const secondShellId = await secondPanel
      .locator('[data-terminal-agent-id]')
      .first()
      .getAttribute('data-terminal-agent-id');
    if (!secondShellId) throw new Error('Second root task has no shell identity');

    await firstPanel.getByTitle('Close task', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Close Task' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(firstPanel).toHaveCount(0, { timeout: 15_000 });
    await expect(secondPanel).toBeVisible();
    await secondPanel.getByTitle(sharedRootTitle).first().click();
    await browserLab.waitForActiveTerminalInteractiveReady(page, { timeoutMs: 15_000 });
    const input = secondPanel.locator('textarea[aria-label="Terminal input"]').first();
    await input.focus();
    await input.pressSequentially("printf 'ROOT_%s\\n' 'SURVIVED'", { delay: 20 });
    await input.press('Enter');
    await browserLab.waitForAgentScrollback(request, secondShellId, 'ROOT_SURVIVED');

    expect(
      execFileSync('git', ['branch', '--show-current'], {
        cwd: browserLab.server.repoDir,
        encoding: 'utf8',
      }).trim(),
    ).toBe(rootBranch);
    expect(await readFile(path.join(browserLab.server.repoDir, sentinelName), 'utf8')).toBe(
      'Keep shared root files\n',
    );
    await expect(page.locator(`[data-task-id="${browserLab.server.taskId}"]`)).toHaveCount(1);
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
