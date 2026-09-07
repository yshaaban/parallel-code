import { IPC } from '../../electron/ipc/channels.js';
import {
  deriveLegacyTaskInitialPromptDeliveryId,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  type TaskInitialPromptDeliveryProjection,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
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

test.describe('legacy initial-prompt recovery', () => {
  const prompt = 'Review the preserved legacy prompt before explicitly sending';
  test.use({
    scenario: {
      ...createPersistentPromptReadyScenario(80),
      legacyInitialPrompt: prompt,
    },
  });

  test('preserves an uncertain legacy draft across reload and confirms before sending once', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, { displayName: 'Legacy Prompt Tester' });
    const { taskId, agentId } = browserLab.server;
    const deliveryId = deriveLegacyTaskInitialPromptDeliveryId({
      agentId,
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId,
      text: prompt,
    });
    const taskPanel = page.locator(`[data-task-id="${taskId}"]`);
    const control = taskPanel.getByRole('region', { name: 'Initial prompt delivery' });
    const readProjection = () =>
      browserLab.invokeSessionIpc<TaskInitialPromptDeliveryProjection | null>(
        request,
        page,
        IPC.GetInitialPromptDeliveryProjection,
        { deliveryId },
      );
    const readOutput = async () => {
      const encoded = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
        agentId,
      });
      return Buffer.from(encoded, 'base64').toString('utf8');
    };

    await expect(control.getByLabel('Initial prompt draft')).toHaveValue(prompt);
    await expect(control).toContainText('Previous delivery is unknown');
    await expect
      .poll(async () => {
        const snapshots = await browserLab.invokeIpc<AgentSupervisionSnapshot[]>(
          request,
          IPC.GetAgentSupervision,
        );
        return snapshots.find((snapshot) => snapshot.agentId === agentId)?.state;
      })
      .toBe('idle-at-prompt');

    const recovered = await readProjection();
    expect(recovered).toMatchObject({
      currentDraft: { mode: 'manual-only', text: prompt },
      delivery: { attempts: 0, deliveryId, priorDeliveryUnknown: true, status: 'manual-required' },
    });
    expect(await readOutput()).not.toContain(prompt);

    await test.info().attach('legacy-prompt-recovery', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await page.reload();
    await expect(control.getByLabel('Initial prompt draft')).toHaveValue(prompt);
    const reloaded = await readProjection();
    expect(reloaded?.delivery).toEqual(recovered?.delivery);
    expect(reloaded?.currentDraft).toMatchObject({
      editRevision: recovered?.currentDraft?.editRevision,
      fingerprint: recovered?.currentDraft?.fingerprint,
      mode: 'manual-only',
      text: prompt,
    });
    expect(reloaded?.manualSendOperation).toEqual(recovered?.manualSendOperation);
    expect(await readOutput()).not.toContain(prompt);
    await control.getByRole('button', { name: 'Inspect terminal', exact: true }).click();
    await expect(taskPanel.locator('.xterm-helper-textarea')).toBeFocused();

    await control.getByRole('button', { name: 'Send initial prompt', exact: true }).click();
    await expect(control.getByRole('button', { name: 'Confirm send', exact: true })).toBeEnabled();
    expect((await readProjection())?.manualSendOperation?.phase).toBe('confirmation-required');
    expect(await readOutput()).not.toContain(prompt);

    await control.getByRole('button', { name: 'Confirm send', exact: true }).click();
    await expect
      .poll(async () => {
        const operation = (await readProjection())?.manualSendOperation;
        return {
          phase: operation?.phase,
          outcome: (operation?.latestAttemptReceipt ?? operation?.terminalReceipt)?.outcome,
        };
      })
      .toMatchObject({ phase: 'completed', outcome: { kind: 'sent' } });
    await browserLab.waitForAgentScrollback(request, agentId, prompt);
    await expect(control).toHaveCount(0);
    expect((await readOutput()).split(prompt)).toHaveLength(2);
  });
});
