import { expect, test } from '@playwright/test';
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
