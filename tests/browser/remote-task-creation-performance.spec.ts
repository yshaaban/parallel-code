import { expect, test } from '@playwright/test';
import {
  installRemoteTaskExperienceMock,
  startRemoteStaticServer,
  type RemoteStaticServer,
} from './harness/remote-task-experience.js';

const ACKNOWLEDGEMENT_P95_BUDGET_MS = 2_000;
const SAMPLE_COUNT = 5;

test.describe('remote task creation performance', () => {
  let staticServer: RemoteStaticServer;

  test.beforeAll(async () => {
    staticServer = await startRemoteStaticServer();
  });

  test.afterAll(async () => {
    await staticServer.stop();
  });

  test('keeps terminal-task acknowledgement p95 below two seconds', async ({ page }) => {
    const samples: number[] = [];
    await page.setViewportSize({ height: 720, width: 320 });
    await installRemoteTaskExperienceMock(page);
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      await page.goto(`${staticServer.url}/remote?token=browser-test`, {
        waitUntil: 'networkidle',
      });
      const newTask = page.getByRole('button', { name: 'New task' });
      await expect(newTask).toBeEnabled();
      await newTask.click();
      await page.getByLabel('Task name').fill(`Performance terminal ${index}`);
      await page.getByLabel('Terminal only').check();
      await page.getByLabel('Working location').selectOption('project-root');

      const startedAt = performance.now();
      await page.getByRole('button', { name: 'Ready to create' }).click();
      await expect(
        page.getByRole('heading', { name: `Performance terminal ${index}` }),
      ).toBeVisible();
      samples.push(performance.now() - startedAt);
    }

    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    test.info().annotations.push({
      description: `${p95.toFixed(3)}ms (budget ${ACKNOWLEDGEMENT_P95_BUDGET_MS}ms)`,
      type: 'remote-task-creation-ack-p95',
    });
    expect(p95).toBeLessThan(ACKNOWLEDGEMENT_P95_BUDGET_MS);
  });
});
