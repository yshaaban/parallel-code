import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resetTaskCommandLeasesForTest } from '../../electron/ipc/task-command-leases.js';
import {
  getCoordinatorRun,
  resetCoordinatorRuntimeForTests,
} from '../../electron/coordinator/runtime.js';
import {
  createCoordinatorRunForTask,
  resetCoordinatorServiceForTests,
} from '../../electron/coordinator/service.js';
import {
  executeCoordinatorToolCall,
  resetCoordinatorToolGatewayForTests,
} from '../../electron/coordinator/tool-gateway.js';
import type { HandlerContext } from '../../electron/ipc/handler-context.js';
import type { StorageEnv } from '../../electron/ipc/storage.js';
import {
  isCoordinatorTerminalWorkflowStatus,
  type CoordinatorToolCallEnvelope,
  type CoordinatorWorkflowSnapshot,
} from '../../src/domain/coordinator.js';

interface EmpiricalWorkflowResult {
  durationMs: number;
  findingSummaries: string[];
  outputTail: string;
  resultCount: number;
  summary: string;
  workflowStatus: CoordinatorWorkflowSnapshot['status'];
}

interface WorkloadDefinition {
  files: string[];
  id: string;
  title: string;
}

interface CoordinatorGatewayContext {
  context: HandlerContext;
  taskNames: { deleteTask: (taskId: string) => void; registerCreatedTask: () => void };
}

const LIVE_WORKLOADS: WorkloadDefinition[] = [
  {
    files: ['src/domain/coordinator-workflow-spec.ts'],
    id: 'runtime',
    title: 'Runtime workflow review',
  },
  {
    files: ['src/components/task-panel/TaskCoordinatorSection.tsx'],
    id: 'ui-docs',
    title: 'UI and docs workflow review',
  },
];

function getSelectedWorkloads(): WorkloadDefinition[] {
  const raw = process.env.COORDINATOR_EMPIRICAL_WORKLOADS?.trim();
  if (!raw) {
    return LIVE_WORKLOADS;
  }

  const requested = new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return LIVE_WORKLOADS.filter((workload) => requested.has(workload.id));
}

async function createEnv(): Promise<StorageEnv & { coordinatorToolCallUrl?: () => string }> {
  const userDataPath = await mkdtemp(
    path.join(os.tmpdir(), 'parallel-code-coordinator-real-workload-'),
  );
  return {
    isPackaged: false,
    userDataPath,
  } as StorageEnv & { coordinatorToolCallUrl?: () => string };
}

function createContext(
  env: StorageEnv & { coordinatorToolCallUrl?: () => string },
): HandlerContext {
  return {
    ...env,
    emitIpcEvent: () => {},
    sendToChannel: () => {},
  };
}

async function readCredentialToken(credentialPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(credentialPath, 'utf8')) as { token: string };
  return parsed.token;
}

async function callTool<T>(
  gateway: {
    context: HandlerContext;
    taskNames: { deleteTask: (taskId: string) => void; registerCreatedTask: () => void };
  },
  envelope: CoordinatorToolCallEnvelope,
): Promise<T> {
  const response = await executeCoordinatorToolCall(gateway, envelope);
  return response.result as T;
}

function createProblem(workload: WorkloadDefinition): string {
  return [
    `Review ${workload.files.join(' and ')} in this repo.`,
    'Do not edit files.',
    'Keep the pass narrow and finish quickly.',
    'Treat documented join-mode fan-in semantics as intentional: downstream stages may start on partial upstream results when joinMode is any, first-success, or quorum.',
    'Submit a concise typed result with summary, at most 2 findings only when they are concrete, evidence quoting the relevant file paths, and commandsRun listing any inspection commands.',
  ].join(' ');
}

function isTerminalWorkflowStatus(status: CoordinatorWorkflowSnapshot['status']): boolean {
  return isCoordinatorTerminalWorkflowStatus(status);
}

function formatJournalTail(workflow: CoordinatorWorkflowSnapshot | undefined): string {
  if (!workflow) {
    return 'missing';
  }
  return workflow.journal
    .slice(-3)
    .map((entry) => `${entry.kind}:${entry.message}`)
    .join(' | ');
}

async function readOutputTail(
  gateway: CoordinatorGatewayContext,
  runId: string,
  taskId: string,
  token: string,
  targetTaskId: string | undefined,
  callId: string,
): Promise<string> {
  if (!targetTaskId) {
    return '';
  }

  const result = await callTool<{ output: string }>(gateway, {
    callId,
    payload: { maxBytes: 12000, targetTaskId },
    runId,
    taskId,
    token,
    toolName: 'get_task_output',
  });
  return result.output.slice(-4000);
}

async function runWorkload(workload: WorkloadDefinition): Promise<EmpiricalWorkflowResult> {
  resetTaskCommandLeasesForTest();
  resetCoordinatorToolGatewayForTests();
  resetCoordinatorRuntimeForTests();
  await resetCoordinatorServiceForTests();

  const env = await createEnv();
  let toolCallUrl = '';
  env.coordinatorToolCallUrl = () => toolCallUrl;
  const context = createContext(env);
  const taskNames = {
    deleteTask: (_taskId: string) => {},
    registerCreatedTask: () => {},
  };
  const gateway = { context, taskNames };

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/coordinator/tool-call') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    try {
      const envelope = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as CoordinatorToolCallEnvelope;
      const response = await executeCoordinatorToolCall(gateway, envelope);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    } catch (error) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address for the coordinator empirical server');
  }
  toolCallUrl = `http://127.0.0.1:${address.port}/api/coordinator/tool-call`;

  try {
    const problem = createProblem(workload);
    const runResult = createCoordinatorRunForTask(context, {
      coordinatorAgentId: `agent-empirical-${workload.id}`,
      coordinatorTaskId: `task-empirical-${workload.id}`,
      projectId: `project-empirical-${workload.id}`,
      projectMode: 'git',
      projectRoot: process.cwd(),
    });
    const token = await readCredentialToken(runResult.credentialPath);
    const startTime = Date.now();
    const started = await callTool<{ workflow: CoordinatorWorkflowSnapshot }>(gateway, {
      callId: `start-empirical-${workload.id}`,
      payload: {
        agent: {
          args: [
            '--model',
            'gpt-5.5',
            '--dangerously-bypass-approvals-and-sandbox',
            '--dangerously-bypass-hook-trust',
          ],
          command: 'codex',
          followupPromptMode: 'disallow',
          initialAssignmentMode: 'spawn-seeded-interactive',
          readinessPolicy: 'codex',
        },
        problem,
        spec: {
          steps: [
            {
              id: 'inspect',
              kind: 'worker',
              name: workload.title,
              prompt: problem,
            },
          ],
        },
        template: 'custom',
        title: workload.title,
      },
      runId: runResult.run.id,
      taskId: runResult.run.coordinatorTaskId,
      token,
      toolName: 'start_workflow',
    });

    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const snapshot = getCoordinatorRun(runResult.run.id);
      const workflow = snapshot?.workflows.find(
        (candidate) => candidate.id === started.workflow.id,
      );
      if (!workflow) {
        throw new Error('Empirical workflow disappeared before completion');
      }
      if (isTerminalWorkflowStatus(workflow.status)) {
        const subtask = snapshot?.subtasks[0];
        const outputTail = await readOutputTail(
          gateway,
          runResult.run.id,
          runResult.run.coordinatorTaskId,
          token,
          subtask?.taskId,
          `output-${workload.id}`,
        );
        return {
          durationMs: Date.now() - startTime,
          findingSummaries: workflow.results[0]?.findings.map((finding) => finding.summary) ?? [],
          outputTail,
          resultCount: workflow.results.length,
          summary: workflow.results[0]?.summary ?? '',
          workflowStatus: workflow.status,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const snapshot = getCoordinatorRun(runResult.run.id);
    const workflow = snapshot?.workflows.find((candidate) => candidate.id === started.workflow.id);
    const subtask = snapshot?.subtasks[0];
    const outputTail = await readOutputTail(
      gateway,
      runResult.run.id,
      runResult.run.coordinatorTaskId,
      token,
      subtask?.taskId,
      `timeout-output-${workload.id}`,
    );
    throw new Error(
      [
        `Timed out waiting for empirical workload ${workload.id}`,
        `workflowStatus=${workflow?.status ?? 'missing'}`,
        `laneStatuses=${workflow?.lanes.map((lane) => `${lane.name}:${lane.status}`).join(', ') ?? 'missing'}`,
        `resultCount=${workflow?.results.length ?? 'missing'}`,
        `journalTail=${formatJournalTail(workflow)}`,
        `subtaskStatus=${subtask?.status ?? 'missing'}`,
        `outputTail=${JSON.stringify(outputTail)}`,
      ].join('\n'),
    );
  } finally {
    server.close();
    await rm(env.userDataPath, { force: true, recursive: true });
  }
}

const runIfEmpirical = process.env.RUN_COORDINATOR_EMPIRICAL === '1' ? it : it.skip;

describe('coordinator real workload proving', () => {
  runIfEmpirical(
    'runs repeated live repo workloads through the coordinator workflow path',
    async () => {
      const results: Record<string, EmpiricalWorkflowResult> = {};
      const workloads = getSelectedWorkloads();
      expect(workloads.length).toBeGreaterThan(0);
      for (const workload of workloads) {
        results[workload.id] = await runWorkload(workload);
      }

      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

      for (const workload of workloads) {
        expect(results[workload.id]?.workflowStatus).toBe('completed');
        expect(results[workload.id]?.resultCount).toBeGreaterThan(0);
        expect(results[workload.id]?.summary.length).toBeGreaterThan(0);
      }
    },
    420_000,
  );
});
