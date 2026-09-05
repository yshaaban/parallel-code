import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const rootBranch = 'integration/trunk';
const sentinelName = 'shared-root-sentinel.txt';
const sharedRootTitle =
  /Works directly in the project root on integration\/trunk; shares files and Git state/;

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
