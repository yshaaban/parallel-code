import { IPC } from '../../electron/ipc/channels.js';
import type { TaskInitialPromptDeliveryProjection } from '../../src/domain/task-initial-prompt-delivery.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import { expect, test } from './harness/fixtures.js';
import { createPersistentPromptReadyScenario } from './harness/scenarios.js';

test.describe('managed initial-prompt delivery', () => {
  const scenario = createPersistentPromptReadyScenario(80);
  test.use({ scenario });

  test('delivers the canonical draft once and reflects backend truth in the task UI', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, { displayName: 'Prompt Tester' });
    const prompt = 'Verify the managed initial prompt path';
    const created = await browserLab.invokeSessionIpc<CreateTaskResult>(
      request,
      page,
      IPC.CreateTask,
      {
        agentDefId: scenario.agentDef.id,
        initialPrompt: prompt,
        name: 'Initial prompt proof task',
        operationId: 'browser-initial-prompt-1',
        projectId: browserLab.server.projectId,
        projectRoot: browserLab.server.repoDir,
        skipPermissions: false,
        symlinkDirs: [],
      },
    );
    expect(created.initial_prompt_delivery_id).toBeTruthy();
    expect(created.session_id).toBeTruthy();
    const taskPanel = page.locator(`[data-task-id="${created.id}"]`);

    await expect(
      taskPanel.getByRole('heading', { name: 'Initial prompt proof task' }),
    ).toBeVisible();
    await browserLab.waitForAgentScrollback(request, created.session_id as string, prompt, 15_000);

    const projection =
      await browserLab.invokeSessionIpc<TaskInitialPromptDeliveryProjection | null>(
        request,
        page,
        IPC.GetInitialPromptDeliveryProjection,
        { deliveryId: created.initial_prompt_delivery_id },
      );
    expect(projection).toMatchObject({
      delivery: {
        agentId: created.session_id,
        deliveryId: created.initial_prompt_delivery_id,
        status: 'delivered',
        targetGeneration: 0,
        taskId: created.id,
      },
    });
    await expect(taskPanel.getByRole('region', { name: 'Initial prompt delivery' })).toHaveCount(0);
    await expect(
      taskPanel.getByPlaceholder('Send a prompt... (Enter to send, Shift+Enter for newline)'),
    ).toBeVisible();
  });
});
