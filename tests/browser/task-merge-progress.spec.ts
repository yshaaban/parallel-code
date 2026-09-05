import type { Page } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import type { RendererInvokeResponseMap } from '../../src/domain/renderer-invoke.js';
import { expect, test } from './harness/fixtures.js';
import {
  createTaskMergeBrowserScenario,
  finishMergeProgressRenderTracker,
  openMergeProgress,
  prepareTaskMerge,
  readBrowserMergeProgress,
  startMergeProgressRenderTracker,
} from './harness/task-merge.js';

const RETAINED_OPERATION_STORAGE_KEY = 'parallel-code-task-merge-operations-v1';

type StartTaskMergeResult = RendererInvokeResponseMap[IPC.StartTaskMergeOperation];

interface LoadedWorkspaceState {
  json: string;
  revision: number;
}

interface MergeProgressWorkspaceProjection {
  collapsedTaskOrder: string[];
  mergeProgress?: {
    linesAdded: number;
    linesRemoved: number;
    tasksToday: number;
    version: number;
  };
  taskOrder: string[];
  tasks: Record<string, unknown>;
}

function parseWorkspace(document: LoadedWorkspaceState): MergeProgressWorkspaceProjection {
  return JSON.parse(document.json) as MergeProgressWorkspaceProjection;
}

function requireWorkspaceMergeProgress(
  document: LoadedWorkspaceState,
): NonNullable<MergeProgressWorkspaceProjection['mergeProgress']> {
  const progress = parseWorkspace(document).mergeProgress;
  if (!progress) {
    throw new Error('Canonical workspace omitted merge progress');
  }
  return progress;
}

async function hasRetainedMergeCredential(page: Page): Promise<boolean> {
  return page.evaluate(
    (storageKey) => window.sessionStorage.getItem(storageKey) !== null,
    RETAINED_OPERATION_STORAGE_KEY,
  );
}

test.describe('browser task merge progress', () => {
  test.describe('managed worktree with line changes', () => {
    const scenario = createTaskMergeBrowserScenario();
    test.use({ scenario });

    test('recovers every lost Start reply and converges two clients on one removal and progress commit', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(60_000);
      const owner = await browserLab.openSession(browser, {
        clientId: 'task-merge-owner',
        displayName: 'Merge owner',
      });
      const peer = await browserLab.openSession(browser, {
        clientId: 'task-merge-peer',
        displayName: 'Merge peer',
      });
      const successfulStartResults: StartTaskMergeResult[] = [];
      let startRequestCount = 0;
      let statusRequestCount = 0;

      try {
        await Promise.all([openMergeProgress(owner.page), openMergeProgress(peer.page)]);
        const initialProgress = requireWorkspaceMergeProgress(
          await browserLab.invokeSessionIpc<LoadedWorkspaceState>(
            request,
            owner.page,
            IPC.LoadWorkspaceState,
          ),
        );
        const taskSelector = `[data-task-id="${browserLab.server.taskId}"]`;
        await expect(owner.page.locator(taskSelector)).toBeVisible();
        await expect(peer.page.locator(taskSelector)).toBeVisible();
        await expect
          .poll(() => readBrowserMergeProgress(owner.page))
          .toEqual({
            linesAdded: 0,
            linesRemoved: 0,
            tasksToday: 0,
          });
        await expect
          .poll(() => readBrowserMergeProgress(peer.page))
          .toEqual({
            linesAdded: 0,
            linesRemoved: 0,
            tasksToday: 0,
          });

        const confirm = await prepareTaskMerge(owner.page, true);
        const ownerRenderTracker = await startMergeProgressRenderTracker(owner.page);
        const peerRenderTracker = await startMergeProgressRenderTracker(peer.page);
        await owner.page.route(`**/api/ipc/${IPC.GetTaskMergeOperationStatus}`, async (route) => {
          statusRequestCount += 1;
          await route.continue();
        });
        await owner.page.route(`**/api/ipc/${IPC.StartTaskMergeOperation}`, async (route) => {
          startRequestCount += 1;
          if (successfulStartResults.length === 0) {
            const response = await route.fetch();
            const payload = (await response.json()) as { result?: StartTaskMergeResult };
            if (!response.ok() || !payload.result) {
              throw new Error('The admitted Start request did not complete successfully');
            }
            successfulStartResults.push(payload.result);
          }
          // The first backend attempt completed, but the renderer receives no Start response.
          // Later retry requests are dropped before the backend so Status is the only recovery join.
          await route.abort('failed');
        });

        await confirm.click();
        await expect(owner.page.locator(taskSelector)).toHaveCount(0, { timeout: 20_000 });
        await expect(peer.page.locator(taskSelector)).toHaveCount(0, { timeout: 20_000 });
        await expect
          .poll(() => readBrowserMergeProgress(owner.page), { timeout: 20_000 })
          .toEqual({
            linesAdded: 3,
            linesRemoved: 0,
            tasksToday: 1,
          });
        await expect
          .poll(() => readBrowserMergeProgress(peer.page), { timeout: 20_000 })
          .toEqual({
            linesAdded: 3,
            linesRemoved: 0,
            tasksToday: 1,
          });
        await expect
          .poll(() => hasRetainedMergeCredential(owner.page), { timeout: 10_000 })
          .toBe(false);

        const [ownerRenders, peerRenders] = await Promise.all([
          finishMergeProgressRenderTracker(owner.page, ownerRenderTracker),
          finishMergeProgressRenderTracker(peer.page, peerRenderTracker),
        ]);
        expect(ownerRenders.batches).toBe(1);
        expect(peerRenders.batches).toBe(1);
        expect(startRequestCount).toBeGreaterThanOrEqual(1);
        expect(statusRequestCount).toBe(1);
        expect(successfulStartResults).toHaveLength(1);
        expect(successfulStartResults[0]).toMatchObject({
          currentProgress: {
            linesAdded: 3,
            linesRemoved: 0,
            tasksToday: 1,
            version: initialProgress.version + 1,
          },
          originalOutcome: { counted: true, phase: 'completed', taskReleased: true },
        });

        const publicEnvelope = JSON.stringify(successfulStartResults[0]);
        expect(publicEnvelope).not.toContain(browserLab.server.repoDir);
        expect(publicEnvelope).not.toContain('operationCapability');
        expect(publicEnvelope).not.toContain('cleanupPlan');
        expect(publicEnvelope).not.toContain('projectRoot');
        expect(publicEnvelope).not.toContain('worktreePath');

        const [ownerDocument, peerDocument] = await Promise.all([
          browserLab.invokeSessionIpc<LoadedWorkspaceState>(
            request,
            owner.page,
            IPC.LoadWorkspaceState,
          ),
          browserLab.invokeSessionIpc<LoadedWorkspaceState>(
            request,
            peer.page,
            IPC.LoadWorkspaceState,
          ),
        ]);
        expect(peerDocument).toEqual(ownerDocument);
        const workspace = parseWorkspace(ownerDocument);
        expect(workspace.tasks).not.toHaveProperty(browserLab.server.taskId);
        expect(workspace.taskOrder).not.toContain(browserLab.server.taskId);
        expect(workspace.collapsedTaskOrder).not.toContain(browserLab.server.taskId);
        expect(workspace.mergeProgress).toMatchObject({
          linesAdded: 3,
          linesRemoved: 0,
          tasksToday: 1,
          version: initialProgress.version + 1,
        });
      } finally {
        await Promise.all([owner.context.close(), peer.context.close()]);
      }
    });

    test('keeps the task and does not count progress when cleanup is disabled', async ({
      browser,
      browserLab,
      request,
    }) => {
      const { context, page } = await browserLab.openSession(browser, {
        displayName: 'Merge without cleanup',
      });
      let startResult: StartTaskMergeResult | null = null;

      try {
        await openMergeProgress(page);
        const initialProgress = requireWorkspaceMergeProgress(
          await browserLab.invokeSessionIpc<LoadedWorkspaceState>(
            request,
            page,
            IPC.LoadWorkspaceState,
          ),
        );
        await page.route(`**/api/ipc/${IPC.StartTaskMergeOperation}`, async (route) => {
          const response = await route.fetch();
          const payload = (await response.json()) as { result: StartTaskMergeResult };
          startResult = payload.result;
          await route.fulfill({ response });
        });
        const confirm = await prepareTaskMerge(page, false);
        await confirm.click();
        await expect(page.getByRole('dialog', { name: 'Merge into main' })).toHaveCount(0, {
          timeout: 20_000,
        });
        await expect(page.locator(`[data-task-id="${browserLab.server.taskId}"]`)).toBeVisible();
        await expect
          .poll(() => readBrowserMergeProgress(page))
          .toEqual({
            linesAdded: 0,
            linesRemoved: 0,
            tasksToday: 0,
          });

        expect(startResult).toMatchObject({
          currentProgress: {
            linesAdded: 0,
            linesRemoved: 0,
            tasksToday: 0,
            version: initialProgress.version,
          },
          currentRemoval: null,
          originalOutcome: {
            counted: false,
            phase: 'completed-not-counted',
            taskReleased: false,
          },
        });
        const document = await browserLab.invokeSessionIpc<LoadedWorkspaceState>(
          request,
          page,
          IPC.LoadWorkspaceState,
        );
        expect(parseWorkspace(document).tasks).toHaveProperty(browserLab.server.taskId);
        expect(requireWorkspaceMergeProgress(document).version).toBe(initialProgress.version);
      } finally {
        await context.close();
      }
    });
  });

  test.describe('zero-line managed worktree merge', () => {
    const scenario = createTaskMergeBrowserScenario({
      emptyCommit: true,
      name: 'task-merge-progress-zero-line',
      taskName: 'Zero-line Merge Fixture',
    });
    test.use({ scenario });

    test('counts the completed task exactly once while keeping line totals at zero', async ({
      browser,
      browserLab,
      request,
    }) => {
      const { context, page } = await browserLab.openSession(browser, {
        displayName: 'Zero-line merge',
      });

      try {
        await openMergeProgress(page);
        const initialProgress = requireWorkspaceMergeProgress(
          await browserLab.invokeSessionIpc<LoadedWorkspaceState>(
            request,
            page,
            IPC.LoadWorkspaceState,
          ),
        );
        const confirm = await prepareTaskMerge(page, true);
        await confirm.click();
        await expect(page.locator(`[data-task-id="${browserLab.server.taskId}"]`)).toHaveCount(0, {
          timeout: 20_000,
        });
        await expect
          .poll(() => readBrowserMergeProgress(page), { timeout: 20_000 })
          .toEqual({
            linesAdded: 0,
            linesRemoved: 0,
            tasksToday: 1,
          });
        const document = await browserLab.invokeSessionIpc<LoadedWorkspaceState>(
          request,
          page,
          IPC.LoadWorkspaceState,
        );
        expect(parseWorkspace(document).mergeProgress).toMatchObject({
          linesAdded: 0,
          linesRemoved: 0,
          tasksToday: 1,
          version: initialProgress.version + 1,
        });
      } finally {
        await context.close();
      }
    });
  });
});
