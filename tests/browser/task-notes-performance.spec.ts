import { expect, test } from '@playwright/test';
import {
  installRemoteTaskExperienceMock,
  startRemoteStaticServer,
  type RemoteStaticServer,
} from './harness/remote-task-experience.js';

const INPUT_P95_BUDGET_MS = 4;
const ISSUE_SAVE_P95_BUDGET_MS = 1_000;
const REPLAY_BUDGET_MS = 500;
const SAVE_SAMPLE_COUNT = 5;
const DOM_COMMIT_BATCH_BUDGET = 80;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;

function distribution(samples: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = (quantile: number) =>
    sorted[Math.ceil(sorted.length * quantile) - 1] ?? Number.POSITIVE_INFINITY;
  return { p50: value(0.5), p95: value(0.95), p99: value(0.99) };
}

test.describe('remote task Notes performance', () => {
  let staticServer: RemoteStaticServer;

  test.beforeAll(async () => {
    staticServer = await startRemoteStaticServer();
  });

  test.afterAll(async () => {
    await staticServer.stop();
  });

  test('keeps real-browser keydown-to-input p95 within the mobile budget', async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 360 });
    await installRemoteTaskExperienceMock(page);
    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page
      .getByRole('button', { name: 'Open Mobile shell task. Running. Terminal-only task.' })
      .click();
    await page.getByRole('tab', { name: 'Notes' }).click();
    const editor = page.getByRole('textbox', { name: 'Task notes' });
    await expect(editor).toHaveValue('base note');

    await editor.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement & {
        __inputLatencySamples?: number[];
        __lastKeydownAt?: number;
      };
      textarea.__inputLatencySamples = [];
      textarea.addEventListener('keydown', () => {
        textarea.__lastKeydownAt = performance.now();
      });
      textarea.addEventListener('input', () => {
        if (textarea.__lastKeydownAt === undefined) return;
        textarea.__inputLatencySamples?.push(performance.now() - textarea.__lastKeydownAt);
      });
    });
    await editor.focus();
    await page.keyboard.type('abcdefghijklmnopqrstuvwxyz'.repeat(4));

    const samples = await editor.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement & { __inputLatencySamples?: number[] };
      return [...(textarea.__inputLatencySamples ?? [])];
    });
    expect(samples).toHaveLength(104);
    const input = distribution(samples);
    test.info().annotations.push({
      description: `${input.p95.toFixed(3)}ms (budget ${INPUT_P95_BUDGET_MS}ms)`,
      type: 'task-notes-input-p95',
    });
    process.stdout.write(
      `task-notes-browser-input samples=${samples.length} p50=${input.p50.toFixed(3)}ms p95=${input.p95.toFixed(3)}ms p99=${input.p99.toFixed(3)}ms budget=${INPUT_P95_BUDGET_MS}ms\n`,
    );
    expect(input.p95).toBeLessThan(INPUT_P95_BUDGET_MS);
  });

  test('bounds save latency, HTTP payloads, DOM commits, and preserves the terminal owner', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 360 });
    const remote = await installRemoteTaskExperienceMock(page, {
      notesScenario: 'always-saved',
    });
    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page
      .getByRole('button', { name: 'Open Mobile shell task. Running. Terminal-only task.' })
      .click();
    await page.getByRole('button', { name: 'Open Terminal. Running.' }).click();
    const terminalShell = page.getByTestId('remote-terminal-shell');
    await expect(terminalShell.locator('.xterm-rows')).toContainText('CATALOG_SHELL_ATTACHED');
    await terminalShell.evaluate((element) => element.setAttribute('data-preserved', 'yes'));
    await expect.poll(() => remote.getSubscribeCount(page, 'shell-session-1')).toBe(1);

    await page.getByRole('tab', { name: 'Notes' }).click();
    const notesSurface = page.locator('section.task-notes');
    await notesSurface.evaluate((element) => {
      const observed = element as HTMLElement & {
        __domCommitBatches?: number;
        __domMutationRecords?: number;
      };
      observed.__domCommitBatches = 0;
      observed.__domMutationRecords = 0;
      const observer = new MutationObserver((records) => {
        observed.__domCommitBatches = (observed.__domCommitBatches ?? 0) + 1;
        observed.__domMutationRecords = (observed.__domMutationRecords ?? 0) + records.length;
      });
      observer.observe(observed, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
    const editor = page.getByRole('textbox', { name: 'Task notes' });
    await expect(editor).toHaveValue('base note');

    const saveSamples: number[] = [];
    for (let index = 0; index < SAVE_SAMPLE_COUNT; index += 1) {
      await editor.fill(`browser performance note ${index}`);
      const startedAt = performance.now();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status')).toContainText('Saved');
      saveSamples.push(performance.now() - startedAt);
    }

    const updateCommands = remote.commands.filter(
      (command) => command.command === 'task-notes.update',
    );
    expect(updateCommands).toHaveLength(SAVE_SAMPLE_COUNT);
    const payloadBytes = updateCommands.map((command) => command.bodyBytes);
    for (const command of updateCommands) {
      expect(command.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(command.request)));
      expect(command.bodyBytes).toBeLessThan(MAX_HTTP_BODY_BYTES);
    }
    const domCommits = await notesSurface.evaluate((element) => {
      const observed = element as HTMLElement & {
        __domCommitBatches?: number;
        __domMutationRecords?: number;
      };
      return {
        batches: observed.__domCommitBatches ?? Number.POSITIVE_INFINITY,
        records: observed.__domMutationRecords ?? Number.POSITIVE_INFINITY,
      };
    });
    const save = distribution(saveSamples);
    test.info().annotations.push(
      {
        description: `${save.p95.toFixed(3)}ms (budget ${ISSUE_SAVE_P95_BUDGET_MS}ms)`,
        type: 'task-notes-issue-save-p95',
      },
      {
        description: `${Math.min(...payloadBytes)}-${Math.max(...payloadBytes)} bytes`,
        type: 'task-notes-update-http-body',
      },
      {
        description: `${domCommits.batches} batches / ${domCommits.records} records`,
        type: 'task-notes-dom-commits',
      },
    );
    process.stdout.write(
      `task-notes-browser-issue-save samples=${saveSamples.length} p50=${save.p50.toFixed(3)}ms p95=${save.p95.toFixed(3)}ms p99=${save.p99.toFixed(3)}ms budget=${ISSUE_SAVE_P95_BUDGET_MS}ms payloadBytes=${Math.min(...payloadBytes)}-${Math.max(...payloadBytes)} domCommitBatches=${domCommits.batches} domMutationRecords=${domCommits.records}\n`,
    );
    expect(save.p95).toBeLessThan(ISSUE_SAVE_P95_BUDGET_MS);
    expect(domCommits.batches).toBeLessThanOrEqual(DOM_COMMIT_BATCH_BUDGET);

    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(terminalShell).toHaveAttribute('data-preserved', 'yes');
    await expect(terminalShell.locator('.xterm-rows')).toContainText('CATALOG_SHELL_');
    await expect.poll(() => remote.getSubscribeCount(page, 'shell-session-1')).toBe(1);
  });

  test('replays the exact interrupted Update without another Issue', async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 360 });
    const remote = await installRemoteTaskExperienceMock(page, {
      notesScenario: 'response-loss-replay',
    });
    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page
      .getByRole('button', { name: 'Open Mobile shell task. Running. Terminal-only task.' })
      .click();
    await page.getByRole('tab', { name: 'Notes' }).click();
    const editor = page.getByRole('textbox', { name: 'Task notes' });
    await editor.fill('replay this exact browser payload');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('Task notes transport was interrupted');

    const replayStartedAt = performance.now();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    const replayMs = performance.now() - replayStartedAt;
    const issues = remote.commands.filter((command) => command.command === 'task-notes.issue');
    const updates = remote.commands.filter((command) => command.command === 'task-notes.update');
    expect(issues).toHaveLength(1);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.request).toEqual(updates[0]?.request);
    expect(updates[1]?.bodyBytes).toBe(updates[0]?.bodyBytes);
    test.info().annotations.push({
      description: `${replayMs.toFixed(3)}ms (budget ${REPLAY_BUDGET_MS}ms)`,
      type: 'task-notes-replay-latency',
    });
    process.stdout.write(
      `task-notes-browser-replay samples=1 p50=${replayMs.toFixed(3)}ms p95=${replayMs.toFixed(3)}ms p99=${replayMs.toFixed(3)}ms budget=${REPLAY_BUDGET_MS}ms payloadBytes=${updates[1]?.bodyBytes ?? 0} issues=${issues.length}\n`,
    );
    expect(replayMs).toBeLessThan(REPLAY_BUDGET_MS);
  });
});
