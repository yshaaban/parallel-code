import { IPC } from '../../electron/ipc/channels.js';
import type { BrowserReconnectSnapshot } from '../../src/domain/renderer-invoke.js';
import { expect, test } from './harness/fixtures.js';
import {
  createTaskMergeBrowserScenario,
  finishMergeProgressRenderTracker,
  openMergeProgress,
  prepareTaskMerge,
  readBrowserMergeProgress,
  startMergeProgressRenderTracker,
} from './harness/task-merge.js';

const RECONNECT_METADATA_DELTA_BUDGET_BYTES = 1_024;
const PROGRESS_RENDER_BATCH_BUDGET = 1;

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function measureMergeProgressReconnectDelta(snapshot: BrowserReconnectSnapshot): number {
  if (!snapshot.workspaceStateJson) {
    throw new Error('Reconnect snapshot omitted the canonical workspace payload');
  }
  const workspace = JSON.parse(snapshot.workspaceStateJson) as Record<string, unknown>;
  if (workspace.mergeProgress === undefined) {
    throw new Error('Reconnect workspace omitted the merge progress projection');
  }
  const baselineWorkspace = { ...workspace };
  Reflect.deleteProperty(baselineWorkspace, 'mergeProgress');
  const baseline = {
    ...snapshot,
    workspaceStateJson: JSON.stringify(baselineWorkspace),
  };
  return serializedBytes(snapshot) - serializedBytes(baseline);
}

test.describe('browser task merge progress performance', () => {
  const scenario = createTaskMergeBrowserScenario({ name: 'task-merge-progress-performance' });
  test.use({ scenario });

  test('keeps one render per progress version and reconnect metadata below 1 KiB', async ({
    browser,
    browserLab,
    request,
  }, testInfo) => {
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Merge progress performance',
    });

    try {
      await openMergeProgress(page);
      const confirm = await prepareTaskMerge(page, true);
      const tracker = await startMergeProgressRenderTracker(page);
      await confirm.click();
      await expect
        .poll(() => readBrowserMergeProgress(page), { timeout: 20_000 })
        .toEqual({
          linesAdded: 3,
          linesRemoved: 0,
          tasksToday: 1,
        });
      const renderMeasurement = await finishMergeProgressRenderTracker(page, tracker);
      const reconnect = await browserLab.invokeSessionIpc<BrowserReconnectSnapshot>(
        request,
        page,
        IPC.GetBrowserReconnectSnapshot,
      );
      const reconnectDeltaBytes = measureMergeProgressReconnectDelta(reconnect);
      const publicReconnectPayload = JSON.stringify(reconnect);

      testInfo.annotations.push(
        {
          description: `${renderMeasurement.batches} batch (budget ${PROGRESS_RENDER_BATCH_BUDGET})`,
          type: 'merge-progress-render-batches-per-version',
        },
        {
          description: `${reconnectDeltaBytes} bytes (budget <${RECONNECT_METADATA_DELTA_BUDGET_BYTES})`,
          type: 'merge-progress-reconnect-metadata-delta',
        },
      );
      await testInfo.attach('task-merge-progress-performance.json', {
        body: JSON.stringify(
          {
            reconnectDeltaBytes,
            renderBatches: renderMeasurement.batches,
            renderedSnapshots: renderMeasurement.snapshots.length,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });

      expect(renderMeasurement.batches).toBe(PROGRESS_RENDER_BATCH_BUDGET);
      expect(renderMeasurement.snapshots).toHaveLength(PROGRESS_RENDER_BATCH_BUDGET);
      expect(reconnectDeltaBytes).toBeGreaterThan(0);
      expect(reconnectDeltaBytes).toBeLessThan(RECONNECT_METADATA_DELTA_BUDGET_BYTES);
      expect(publicReconnectPayload).not.toContain('operationCapability');
      expect(publicReconnectPayload).not.toContain('taskMergeOperations');
    } finally {
      await context.close();
    }
  });
});
