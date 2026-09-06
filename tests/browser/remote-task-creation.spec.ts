import { expect, test } from '@playwright/test';
import type { RemoteProjectSummary } from '../../src/domain/task-catalog.js';
import {
  installRemoteTaskExperienceMock,
  startRemoteStaticServer,
  type RemoteStaticServer,
} from './harness/remote-task-experience.js';

test.describe('remote task creation', () => {
  let staticServer: RemoteStaticServer;

  test.beforeAll(async () => {
    staticServer = await startRemoteStaticServer();
  });

  test.afterAll(async () => {
    await staticServer.stop();
  });

  test('creates a project-root terminal task from a 320px task-first surface', async ({ page }) => {
    await page.setViewportSize({ height: 720, width: 320 });
    const remote = await installRemoteTaskExperienceMock(page);

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    const newTask = page.getByRole('button', { name: 'New task' });
    await expect(newTask).toBeEnabled();
    await newTask.click();

    await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
    await page.getByRole('button', { name: 'Ready to create' }).click();
    await expect(page.getByLabel('Task name')).toBeFocused();
    await expect(page.getByRole('alert')).toContainText('Enter a task name');
    await page.getByLabel('Task name').fill('Created phone terminal');
    await page.getByLabel('Terminal only').check();
    await page.getByLabel('Working location').selectOption('project-root');

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.getByRole('button', { name: 'Ready to create' }).click();
    await expect(page.getByRole('heading', { name: 'Created phone terminal' })).toBeVisible();

    const createCommand = remote.commands.find((entry) => entry.command === 'task-creation.create');
    expect(createCommand).toBeDefined();
    expect(createCommand?.request).toMatchObject({
      launch: { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'Created phone terminal',
      projectId: 'project-1',
    });
  });

  test('invalidates project choices immediately and retries failed metadata on a narrow screen', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 760, width: 320 });
    const projects: RemoteProjectSummary[] = ['1', '2'].map((id) => ({
      id: `project-${id}`,
      label: `Project ${id}`,
      labelTruncated: false,
      projectMode: 'git',
      locations: {
        'managed-worktree': { enabled: true },
        'project-root': { enabled: true },
        'existing-worktree': { enabled: true },
      },
      baseBranchChoiceCount: 1,
      baseBranchChoicesTruncated: false,
      worktreeChoiceCount: 1,
      worktreeChoicesTruncated: false,
    }));
    await installRemoteTaskExperienceMock(page, { projects });
    let releaseProjectTwo: (() => void) | undefined;
    const projectTwoGate = new Promise<void>((resolve) => {
      releaseProjectTwo = resolve;
    });
    let failProjectTwo = true;
    await page.route('**/api/commands/task-creation.get-*', async (route) => {
      const command = new URL(route.request().url()).pathname.split('/').at(-1);
      if (
        command !== 'task-creation.get-picker-page' &&
        command !== 'task-creation.get-worktree-link-candidates'
      ) {
        await route.fallback();
        return;
      }
      const request = route.request().postDataJSON() as { projectId: string; kind?: string };
      if (request.projectId === 'project-2') {
        await projectTwoGate;
        if (failProjectTwo) {
          await route.fulfill({ status: 503, body: 'Metadata temporarily unavailable' });
          return;
        }
      }
      const suffix = request.projectId === 'project-1' ? 'first' : 'second';
      const result =
        command === 'task-creation.get-worktree-link-candidates'
          ? {
              kind: 'found',
              candidates: [{ isDefault: true, name: `${suffix}-dependencies` }],
              truncated: false,
            }
          : {
              kind: request.kind,
              catalogVersion: 1,
              generation: 1,
              nextCursor: null,
              serverInstanceId: 'server-1',
              truncated: false,
              items:
                request.kind === 'base-branch'
                  ? [
                      {
                        kind: 'base-branch',
                        label: `${suffix}-branch`,
                        branchLabel: `${suffix}-branch`,
                        ref: `${suffix}-branch-ref`,
                      },
                    ]
                  : [
                      {
                        kind: 'existing-worktree',
                        label: `${suffix}-worktree`,
                        branchLabel: `${suffix}-branch`,
                        ownershipLabel: 'Externally owned',
                        ref: `${suffix}-worktree-ref`,
                      },
                    ],
            };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result }),
      });
    });

    try {
      await page.goto(`${staticServer.url}/remote?token=browser-test`, {
        waitUntil: 'networkidle',
      });
      await page.getByRole('button', { name: 'New task' }).click();
      await page.getByLabel('Base branch (optional)').selectOption('first-branch-ref');
      await page.getByLabel('Reuse selected project dependencies').check();
      await page.getByLabel('Working location').selectOption('existing-worktree');
      await page.getByLabel('Imported worktree').selectOption('first-worktree-ref');
      await page.getByLabel('Project').selectOption('project-2');
      await expect(page.getByLabel('Base branch (optional)')).toBeDisabled();
      await expect(page.getByLabel('Imported worktree')).toBeDisabled();
      await expect(page.getByRole('option', { name: /first-/ })).toHaveCount(0);
      await expect(page.getByText('Loading worktrees…')).toBeVisible();
      await page.getByLabel('Working location').selectOption('managed-worktree');
      await expect(page.getByLabel('Reuse selected project dependencies')).toHaveCount(0);
      await expect(page.getByText(/first-dependencies/)).toHaveCount(0);

      releaseProjectTwo?.();
      await expect(page.getByRole('button', { name: 'Retry branches', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry reusable dependencies' })).toBeVisible();
      failProjectTwo = false;
      await page.getByRole('button', { name: 'Retry branches', exact: true }).click();
      await page.getByLabel('Base branch (optional)').selectOption('second-branch-ref');
      await expect(page.getByText(/Could not load branches/)).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry reusable dependencies' }).click();
      await expect(page.getByLabel('Reuse selected project dependencies')).not.toBeChecked();
      await page.getByLabel('Working location').selectOption('existing-worktree');
      await page.getByRole('button', { name: 'Retry worktrees', exact: true }).click();
      await page.getByLabel('Imported worktree').selectOption('second-worktree-ref');
      await expect(page.getByText(/Could not load/)).toHaveCount(0);
      await expect(page.getByText(/Loading/)).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      releaseProjectTwo?.();
    }
  });

  test('creates a managed agent task only after explicit permission bypass selection', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 760, width: 360 });
    const remote = await installRemoteTaskExperienceMock(page);

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByLabel('Task name').fill('Managed phone agent');
    await page.getByLabel('Initial prompt (optional)').fill('Review the mobile workflow');
    await page.getByText('Advanced', { exact: true }).click();
    const bypass = page.getByLabel('Bypass agent permission prompts');
    await expect(bypass).toBeEnabled();
    await expect(bypass).not.toBeChecked();
    await bypass.check();
    await page.getByRole('button', { name: 'Ready to create' }).click();

    await expect(page.getByRole('heading', { name: 'Managed phone agent' })).toBeVisible();
    const createCommand = remote.commands.find((entry) => entry.command === 'task-creation.create');
    expect(createCommand?.request).toMatchObject({
      launch: {
        agentDefId: 'agent-1',
        initialPrompt: 'Review the mobile workflow',
        kind: 'agent',
        skipPermissions: true,
      },
      location: { kind: 'managed-worktree', requestedLinkNames: [] },
      name: 'Managed phone agent',
      projectId: 'project-1',
    });
  });

  test('shows validating progress and permits capability-bound cancellation while Create is pending', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 720, width: 320 });
    const remote = await installRemoteTaskExperienceMock(page, {
      creationScenario: 'pending-cancel',
    });

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByLabel('Task name').fill('Cancelable phone task');
    await page.getByRole('button', { name: 'Ready to create' }).click();

    await expect(page.getByRole('heading', { name: 'Validating task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel creation' })).toBeEnabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByRole('heading', { name: 'Task creation cancelled' })).toBeVisible();

    expect(
      remote.commands.filter((entry) => entry.command === 'task-creation.create'),
    ).toHaveLength(1);
    expect(remote.commands.some((entry) => entry.command === 'task-creation.get')).toBe(true);
    expect(
      remote.commands.filter((entry) => entry.command === 'task-creation.cancel'),
    ).toHaveLength(1);
  });

  test('uses healthy operation events without periodic status polling', async ({ page }) => {
    await page.setViewportSize({ height: 720, width: 320 });
    const remote = await installRemoteTaskExperienceMock(page, {
      creationScenario: 'pending-cancel',
      liveCreationEvents: true,
    });

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByLabel('Task name').fill('Event driven phone task');
    await page.getByRole('button', { name: 'Ready to create' }).click();

    await expect(page.getByRole('heading', { name: 'Validating task' })).toBeVisible();
    await expect.poll(() => remote.getTaskCreationSubscribeCount(page)).toBe(1);
    await page.waitForTimeout(1_500);
    expect(remote.commands.filter((entry) => entry.command === 'task-creation.get')).toHaveLength(
      0,
    );

    await page.getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByRole('heading', { name: 'Task creation cancelled' })).toBeVisible();
  });

  test('recovers an exact lost Create response through status without duplicate creation', async ({
    page,
  }) => {
    const remote = await installRemoteTaskExperienceMock(page, {
      creationScenario: 'response-loss',
    });

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByLabel('Task name').fill('Recovered phone task');
    await page.getByRole('button', { name: 'Ready to create' }).click();

    await expect(page.getByRole('heading', { name: 'Recovered phone task' })).toBeVisible();
    expect(
      remote.commands.filter((entry) => entry.command === 'task-creation.create'),
    ).toHaveLength(1);
    expect(remote.commands.some((entry) => entry.command === 'task-creation.get')).toBe(true);
  });
});
