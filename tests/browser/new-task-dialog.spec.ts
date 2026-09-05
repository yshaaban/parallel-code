import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

const supportedAgentScenario = createPromptReadyScenario();
supportedAgentScenario.agentDef = {
  ...supportedAgentScenario.agentDef,
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

test.use({
  scenario: supportedAgentScenario,
});

test('covers ignored-file discovery, persisted defaults, and protected New Task drafts', async ({
  browser,
  browserLab,
}) => {
  const { page } = await browserLab.openSession(browser, {
    displayName: 'New Task Defaults',
  });
  let discoveryResponse: 'failure' | 'success' = 'success';
  let nextDiscoveryHold: Promise<void> | null = null;
  let releaseDiscovery: (() => void) | null = null;
  let discoveryRequestCount = 0;
  let discoveryResponseCount = 0;
  const holdNextDiscovery = (): (() => void) => {
    nextDiscoveryHold = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    return () => releaseDiscovery?.();
  };
  await page.route(`**/api/ipc/${IPC.GetGitignoredDirs}`, async (route) => {
    discoveryRequestCount += 1;
    const response = discoveryResponse;
    const hold = nextDiscoveryHold;
    nextDiscoveryHold = null;
    if (hold) {
      await hold;
    }

    if (response === 'failure') {
      await route.fulfill({
        body: JSON.stringify({ error: 'candidate query timed out' }),
        contentType: 'application/json',
        status: 400,
      });
      discoveryResponseCount += 1;
      return;
    }

    await route.fulfill({
      body: JSON.stringify({
        result: {
          candidates: [
            { isDefault: true, name: '.claude' },
            { isDefault: false, name: '.env' },
          ],
          truncated: true,
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    discoveryResponseCount += 1;
  });

  await page.getByRole('button', { name: /^Settings/ }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  const stepsDefault = settingsDialog.getByRole('checkbox', { name: 'Track task steps' });
  const permissionsDefault = settingsDialog.getByRole('checkbox', {
    name: 'Dangerously skip all confirms',
  });
  await expect(stepsDefault).not.toBeChecked();
  await expect(permissionsDefault).toBeChecked();

  await permissionsDefault.click();
  await expect(permissionsDefault).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = window.sessionStorage.getItem('parallel-code-client-session');
        if (!saved) return null;
        const parsed = JSON.parse(saved) as {
          newTaskDefaults?: { skipPermissions?: boolean; stepsTracking?: boolean };
        };
        return parsed.newTaskDefaults ?? null;
      }),
    )
    .toEqual({ skipPermissions: false, stepsTracking: false });

  await settingsDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();

  const openNewTaskButton = page.locator('button').filter({ hasText: /^New Task$/ });
  const releaseInitialDiscovery = holdNextDiscovery();
  await openNewTaskButton.click();
  const newTaskDialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(newTaskDialog.getByText('Checking ignored files…')).toBeVisible();
  const transientPrompt = newTaskDialog.getByPlaceholder(/Describe the task/i);
  await transientPrompt.fill('Temporary loading probe');
  await expect(newTaskDialog.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  releaseInitialDiscovery();
  await expect(newTaskDialog.getByText(/Runs without confirmation/)).toHaveCount(0);
  await newTaskDialog.getByRole('button', { name: /^Advanced/ }).click();
  await expect(
    newTaskDialog.getByRole('checkbox', { name: 'Dangerously skip all confirms' }),
  ).not.toBeChecked();
  await expect(newTaskDialog.getByRole('checkbox', { name: 'Track task steps' })).not.toBeChecked();
  const ignoredFilePicker = newTaskDialog.getByRole('group', {
    name: 'Share ignored files with this worktree',
  });
  await expect(ignoredFilePicker).toBeVisible();
  await expect(ignoredFilePicker.getByRole('checkbox', { name: '.claude' })).toBeChecked();
  await expect(ignoredFilePicker.getByRole('checkbox', { name: '.env' })).not.toBeChecked();
  await expect(
    ignoredFilePicker.getByText(
      'Showing 128 eligible entries; additional entries were not loaded.',
    ),
  ).toBeVisible();
  await expect(ignoredFilePicker).toContainText(
    "Selected entries are linked from the project root. Their names are added to the repo's shared .git/info/exclude and remain ignored for all worktrees.",
  );
  await ignoredFilePicker.getByRole('checkbox', { name: '.env' }).click();
  await transientPrompt.fill('');

  // Unprotected option changes keep the clean close path immediate.
  await page.keyboard.press('Escape');
  await expect(newTaskDialog).toHaveCount(0);

  const githubUrl = 'https://github.com/acme/widget/pull/42';
  const dropGitHubUrl = async (): Promise<void> => {
    await page.locator('.app-shell').evaluate((appShell, url) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', url);
      appShell.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
    }, githubUrl);
  };

  // Advisory failure enables managed creation with an empty selection; retry is explicit.
  discoveryResponse = 'failure';
  await dropGitHubUrl();
  const prefilledDialog = page.getByRole('dialog', { name: 'New Task' });
  const prompt = prefilledDialog.getByPlaceholder(/Describe the task/i);
  const prefilledPrompt = `review ${githubUrl}`;
  await expect(prompt).toHaveValue(prefilledPrompt);
  await expect(
    prefilledDialog.getByText('Ignored file suggestions unavailable: candidate query timed out'),
  ).toBeVisible();
  await expect(prefilledDialog.getByRole('button', { name: 'Create Task' })).toBeEnabled();
  discoveryResponse = 'success';
  await prefilledDialog.getByRole('button', { name: 'Retry' }).click();
  await prefilledDialog.getByRole('button', { name: /^Advanced/ }).click();
  await expect(
    prefilledDialog.getByRole('group', { name: 'Share ignored files with this worktree' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prefilledDialog).toHaveCount(0);

  // A result that arrives after switching to project-root mode is ignored and cannot restore the
  // picker or its submit blocker.
  const releaseStaleDiscovery = holdNextDiscovery();
  await openNewTaskButton.click();
  const staleDialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(staleDialog.getByText('Checking ignored files…')).toBeVisible();
  await staleDialog.getByRole('button', { name: 'Project root' }).click();
  await expect(staleDialog.getByText('Checking ignored files…')).toHaveCount(0);
  releaseStaleDiscovery();
  await expect.poll(() => discoveryResponseCount).toBe(4);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(
    staleDialog.getByRole('group', { name: 'Share ignored files with this worktree' }),
  ).toHaveCount(0);
  await expect.poll(() => discoveryRequestCount).toBe(4);
  await page.keyboard.press('Escape');
  await expect(staleDialog).toHaveCount(0);

  // The final programmatic prefill is the clean baseline.
  await dropGitHubUrl();
  const authoredPrompt = `${prefilledPrompt}\nPlease preserve this authored context.`;
  await prompt.fill(authoredPrompt);
  await prompt.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(8, 8);
  });

  await page.keyboard.press('Escape');
  const discardDialog = page.getByRole('dialog', { name: 'Discard new task draft?' });
  await expect(discardDialog).toBeVisible();
  await expect(
    discardDialog.getByText('Your prompt or task name has changes that will be lost.'),
  ).toBeVisible();
  await expect(discardDialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expect(prompt).toHaveValue(authoredPrompt);

  // Escape belongs to the nested confirmation first and restores the exact edit target/caret.
  await page.keyboard.press('Escape');
  await expect(discardDialog).toHaveCount(0);
  await expect(prefilledDialog).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(authoredPrompt);
  await expect
    .poll(() => prompt.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
    .toBe(8);

  // Overlay dismissal routes through the same confirmation and an admitted discard clears prefill.
  await prefilledDialog.locator('..').click({ position: { x: 2, y: 2 } });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Discard draft' }).click();
  await expect(prefilledDialog).toHaveCount(0);

  await openNewTaskButton.click();
  const freshDialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(freshDialog.getByPlaceholder(/Describe the task/i)).toHaveValue('');
});
