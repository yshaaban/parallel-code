import { IPC } from '../../electron/ipc/channels.js';
import type { TaskInitialPromptDeliveryProjection } from '../../src/domain/task-initial-prompt-delivery.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import { expect, test } from './harness/fixtures.js';
import { createPersistentPromptReadyScenario } from './harness/scenarios.js';

const DELIVERY_ACKNOWLEDGEMENT_P95_BUDGET_MS = 2_000;
const SAMPLE_COUNT = 3;

test.describe('managed initial-prompt delivery performance', () => {
  const scenario = createPersistentPromptReadyScenario(20);
  test.use({ scenario });

  test('keeps ready-to-delivered acknowledgement p95 below two seconds', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, { displayName: 'Prompt Perf' });
    const samples: number[] = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const created = await browserLab.invokeSessionIpc<CreateTaskResult>(
        request,
        page,
        IPC.CreateTask,
        {
          agentDefId: scenario.agentDef.id,
          initialPrompt: `Performance prompt ${index}`,
          name: `Initial prompt performance ${index}`,
          operationId: `browser-initial-prompt-performance-${index}`,
          projectId: browserLab.server.projectId,
          projectRoot: browserLab.server.repoDir,
          skipPermissions: false,
          symlinkDirs: [],
        },
      );
      const deliveryId = created.initial_prompt_delivery_id as string;
      const startedAt = performance.now();
      const transitions: string[] = [];
      let lastVersion = -1;
      await expect
        .poll(
          async () => {
            const projection =
              await browserLab.invokeSessionIpc<TaskInitialPromptDeliveryProjection | null>(
                request,
                page,
                IPC.GetInitialPromptDeliveryProjection,
                { deliveryId },
              );
            if (projection && projection.delivery.version !== lastVersion) {
              lastVersion = projection.delivery.version;
              transitions.push(
                `${(performance.now() - startedAt).toFixed(1)}ms:${projection.delivery.status}:v${projection.delivery.version}:attempt${projection.delivery.attempts}`,
              );
            }
            return projection?.delivery.status;
          },
          { intervals: [50], timeout: 10_000 },
        )
        .toBe('delivered');
      const elapsedMs = performance.now() - startedAt;
      samples.push(elapsedMs);
      process.stdout.write(
        `initial-prompt-delivery sample=${index} elapsed=${elapsedMs.toFixed(3)}ms transitions=${transitions.join(',')}\n`,
      );
    }

    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    test.info().annotations.push({
      description: `${p95.toFixed(3)}ms (budget ${DELIVERY_ACKNOWLEDGEMENT_P95_BUDGET_MS}ms)`,
      type: 'initial-prompt-delivery-ack-p95',
    });
    process.stdout.write(
      `initial-prompt-delivery-ack samples=${samples.length} values=${samples
        .map((sample) => `${sample.toFixed(3)}ms`)
        .join(',')} p95=${p95.toFixed(3)}ms budget=${DELIVERY_ACKNOWLEDGEMENT_P95_BUDGET_MS}ms\n`,
    );
    expect(p95).toBeLessThan(DELIVERY_ACKNOWLEDGEMENT_P95_BUDGET_MS);
  });
});
