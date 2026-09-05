import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC } from '../../electron/ipc/channels.js';
import {
  deriveResumeFallbackOperationId,
  type AgentSessionOperationProjection,
} from '../../src/domain/agent-session-operation.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import { expect, test } from './harness/fixtures.js';
import type { BrowserLabScenario } from './harness/scenarios.js';

const CLAUDE_AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  args: ['--dangerously-skip-permissions'],
  resume_args: ['--continue'],
  resume_failure_classifier: 'claude-no-conversation-v1' as const,
  resume_failure_fallback: 'fresh-start' as const,
  resume_strategy: 'cli-args' as const,
  skip_permissions_args: ['--dangerously-skip-permissions'],
  description: "Anthropic's Claude Code CLI agent",
};

const scenario: BrowserLabScenario = {
  agentCatalogSource: 'built-in',
  agentDef: CLAUDE_AGENT,
  name: 'agent-resume-fallback',
  prependRepoBinToPath: true,
  async seedRepo(repoDir) {
    const binDir = path.join(repoDir, 'bin');
    const executable = path.join(binDir, 'claude');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      executable,
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" --continue "*)',
        '    echo "No conversation found to continue"',
        '    exit 1',
        '    ;;',
        '  *)',
        '    echo "Fresh Claude session"',
        '    sleep 1',
        '    exit 0',
        '    ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(executable, 0o755);
  },
  taskName: 'Resume fallback seed',
};

test.describe('managed agent resume fallback', () => {
  test.use({ scenario });

  test('replaces one failed trusted resume with one fresh generation and explains it', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, { displayName: 'Fallback Tester' });
    const created = await browserLab.invokeSessionIpc<CreateTaskResult>(
      request,
      page,
      IPC.CreateTask,
      {
        agentDefId: 'claude-code',
        initialPrompt: '',
        name: 'Fallback proof task',
        operationId: 'browser-agent-fallback-1',
        projectId: browserLab.server.projectId,
        projectRoot: browserLab.server.repoDir,
        skipPermissions: false,
        symlinkDirs: [],
      },
    );
    expect(created.session_id).toBeTruthy();
    const agentId = created.session_id as string;
    const taskPanel = page.locator(`[data-task-id="${created.id}"]`);

    await expect(taskPanel.getByRole('heading', { name: 'Fallback proof task' })).toBeVisible();
    await expect(taskPanel.getByText('Process exited (0)', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await taskPanel.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(
      page.getByText('Resume was unavailable, so the agent started a fresh session.'),
    ).toBeVisible({ timeout: 15_000 });

    let projection: AgentSessionOperationProjection | null = null;
    await expect
      .poll(
        async () => {
          projection = await browserLab.invokeSessionIpc<AgentSessionOperationProjection | null>(
            request,
            page,
            IPC.GetAgentSessionOperationProjection,
            { agentId, taskId: created.id },
          );
          return projection?.operation;
        },
        { timeout: 15_000 },
      )
      .toMatchObject({
        agentId,
        launchReason: 'resume-fallback',
        operationId: deriveResumeFallbackOperationId(created.id, agentId, 1),
        phase: 'running',
        resumed: false,
        sourceGeneration: 1,
        targetGeneration: 2,
        taskId: created.id,
      });
  });
});
