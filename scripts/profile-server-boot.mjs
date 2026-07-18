import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { createBrowserServerClient } from './browser-server-client.mjs';
import { runOperationWithCleanups } from './lib/cleanup-outcome.mjs';
import {
  spawnStandaloneServerProcess,
  stopStandaloneServerProcessWithRetry,
  waitForStandaloneServerReady,
} from './lib/standalone-server-process.mjs';
import { createTestShellEnv } from './lib/test-shell-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_TASK_COUNTS = [2, 12];
const DEFAULT_ITERATIONS = 3;
const DEFAULT_SETTLED_SAMPLES = 3;
const DEFAULT_GIT_SUBPROCESS_WINDOW_MS = 10_000;
const READINESS_TIMEOUT_MS = 60_000;
const PROFILE_AUTH_TOKEN = 'profile-server-boot-token';

function parseArgs(argv) {
  const options = {
    gitSubprocessWindowMs: DEFAULT_GIT_SUBPROCESS_WINDOW_MS,
    help: false,
    iterations: DEFAULT_ITERATIONS,
    out: null,
    settledSamples: DEFAULT_SETTLED_SAMPLES,
    taskCounts: [...DEFAULT_TASK_COUNTS],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--task-counts': {
        const parsedCounts = (argv[index + 1] ?? '')
          .split(',')
          .map((count) => Number(count.trim()))
          .filter((count) => Number.isInteger(count) && count > 0);
        if (parsedCounts.length > 0) {
          options.taskCounts = parsedCounts;
        }
        index += 1;
        break;
      }
      case '--iterations': {
        const iterations = Number(argv[index + 1]);
        if (Number.isInteger(iterations) && iterations > 0) {
          options.iterations = iterations;
        }
        index += 1;
        break;
      }
      case '--settled-samples': {
        const settledSamples = Number(argv[index + 1]);
        if (Number.isInteger(settledSamples) && settledSamples > 0) {
          options.settledSamples = settledSamples;
        }
        index += 1;
        break;
      }
      case '--git-window-ms': {
        const windowMs = Number(argv[index + 1]);
        if (Number.isFinite(windowMs) && windowMs > 0) {
          options.gitSubprocessWindowMs = windowMs;
        }
        index += 1;
        break;
      }
      case '--out':
        options.out = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/profile-server-boot.mjs [options]

Options:
  --task-counts <a,b,c>      Synthetic task counts to profile (default: ${DEFAULT_TASK_COUNTS.join(',')})
  --iterations <n>           Iterations per task count (default: ${DEFAULT_ITERATIONS})
  --settled-samples <n>      Post-listen bootstrap samples per iteration (default: ${DEFAULT_SETTLED_SAMPLES})
  --git-window-ms <n>        Git subprocess observation window (default: ${DEFAULT_GIT_SUBPROCESS_WINDOW_MS})
  --out <path>               Write the JSON scorecard to a file
  --help                     Print this help and exit
`);
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeSamples(samples) {
  return {
    medianMs: roundMs(median(samples)),
    samplesMs: samples.map((sample) => roundMs(sample)),
  };
}

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function createSyntheticWorkspace(taskCount) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-boot-profile-'));
  try {
    const repoPath = path.join(fixtureRoot, 'project');
    const userDataPath = path.join(fixtureRoot, 'server-data');
    const stateDir = `${userDataPath}-dev`;

    await mkdir(repoPath, { recursive: true });
    runGit(repoPath, ['init', '-b', 'main']);
    runGit(repoPath, ['config', 'user.email', 'profile@parallel-code.local']);
    runGit(repoPath, ['config', 'user.name', 'Boot Profile']);
    await writeFile(path.join(repoPath, 'README.md'), '# Boot profile fixture\n', 'utf8');
    await writeFile(path.join(repoPath, 'main.ts'), 'export const fixture = true;\n', 'utf8');
    runGit(repoPath, ['add', '-A']);
    runGit(repoPath, ['commit', '-m', 'Initial fixture commit']);

    const tasks = {};
    for (let taskIndex = 1; taskIndex <= taskCount; taskIndex += 1) {
      const taskId = `boot-profile-task-${taskIndex}`;
      const branchName = `boot-profile/task-${taskIndex}`;
      const worktreePath = path.join(fixtureRoot, 'worktrees', `task-${taskIndex}`);
      runGit(repoPath, ['worktree', 'add', worktreePath, '-b', branchName, 'main']);
      await writeFile(
        path.join(worktreePath, `task-${taskIndex}.txt`),
        `synthetic change for task ${taskIndex}\n`,
        'utf8',
      );
      tasks[taskId] = {
        branchName,
        id: taskId,
        name: `Boot profile task ${taskIndex}`,
        projectId: 'boot-profile-project',
        worktreePath,
      };
    }

    const state = {
      projects: [{ id: 'boot-profile-project', path: repoPath }],
      tasks,
    };
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    return {
      cleanup: () => rm(fixtureRoot, { force: true, recursive: true }),
      userDataPath,
    };
  } catch (error) {
    try {
      await rm(fixtureRoot, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Synthetic boot workspace setup and cleanup failed',
      );
    }
    throw error;
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function measureInvokeLatencyMs(client, channel) {
  const startedAt = performance.now();
  await client.invokeIpc(channel);
  return performance.now() - startedAt;
}

async function probeFocusSignalSupport(client) {
  try {
    await client.invokeIpc('report_client_task_focus', {
      selectedTaskId: 'boot-profile-task-1',
      visibleTaskIds: ['boot-profile-task-1'],
    });
    return true;
  } catch {
    return false;
  }
}

async function runBootIteration(userDataPath, options) {
  const serverEntry = path.join(projectRoot, 'dist-server', 'server', 'main.js');
  const spawnedAt = performance.now();
  const child = spawnStandaloneServerProcess(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTH_TOKEN: PROFILE_AUTH_TOKEN,
      PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1',
      PARALLEL_CODE_USER_DATA_DIR: userDataPath,
      ...createTestShellEnv(userDataPath),
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return runOperationWithCleanups(
    'Server boot profile iteration',
    async () => {
      const { url: serverUrl } = await waitForStandaloneServerReady(child, {
        timeoutMs: READINESS_TIMEOUT_MS,
      });
      const listenedAt = performance.now();
      const bootToListenMs = listenedAt - spawnedAt;

      const client = createBrowserServerClient({
        authToken: PROFILE_AUTH_TOKEN,
        browserClientId: 'profile-server-boot',
        serverUrl,
      });

      const coldBootstrapDuringBootMs = await measureInvokeLatencyMs(
        client,
        'get_browser_cold_bootstrap',
      );

      const windowElapsedMs = performance.now() - listenedAt;
      if (windowElapsedMs < options.gitSubprocessWindowMs) {
        await sleep(options.gitSubprocessWindowMs - windowElapsedMs);
      }

      const diagnostics = await client.invokeIpc('get_backend_runtime_diagnostics');
      const gitSubprocessCount =
        typeof diagnostics?.gitSubprocessCount === 'number' ? diagnostics.gitSubprocessCount : null;

      const settledSamplesMs = [];
      for (let sampleIndex = 0; sampleIndex < options.settledSamples; sampleIndex += 1) {
        settledSamplesMs.push(await measureInvokeLatencyMs(client, 'get_browser_cold_bootstrap'));
        await sleep(250);
      }

      const focusSignalSupported = await probeFocusSignalSupport(client);

      return {
        bootToListenMs,
        coldBootstrapDuringBootMs,
        focusSignalSupported,
        gitSubprocessCount,
        settledColdBootstrapMs: median(settledSamplesMs),
        settledColdBootstrapSamplesMs: settledSamplesMs,
      };
    },
    [['stop standalone server', () => stopStandaloneServerProcessWithRetry(child)]],
  );
}

async function profileTaskCount(taskCount, options) {
  const workspace = await createSyntheticWorkspace(taskCount);
  const iterations = await runOperationWithCleanups(
    `Server boot profile for ${taskCount} tasks`,
    async () => {
      const completedIterations = [];
      for (let iteration = 0; iteration < options.iterations; iteration += 1) {
        completedIterations.push(await runBootIteration(workspace.userDataPath, options));
      }
      return completedIterations;
    },
    [['remove synthetic workspace', () => workspace.cleanup()]],
  );

  return {
    bootToListenMs: summarizeSamples(iterations.map((entry) => entry.bootToListenMs)),
    coldBootstrapDuringBootMs: summarizeSamples(
      iterations.map((entry) => entry.coldBootstrapDuringBootMs),
    ),
    focusSignalSupported: iterations.every((entry) => entry.focusSignalSupported),
    gitSubprocessCountInWindow: {
      median: median(iterations.map((entry) => entry.gitSubprocessCount ?? 0)),
      samples: iterations.map((entry) => entry.gitSubprocessCount),
    },
    iterations: options.iterations,
    settledColdBootstrapMs: summarizeSamples(
      iterations.map((entry) => entry.settledColdBootstrapMs),
    ),
    taskCount,
  };
}

function buildComparison(results) {
  if (results.length < 2) {
    return null;
  }

  const sortedResults = [...results].sort((left, right) => left.taskCount - right.taskCount);
  const smallest = sortedResults[0];
  const largest = sortedResults[sortedResults.length - 1];
  if (smallest.bootToListenMs.medianMs <= 0) {
    return null;
  }

  return {
    baselineTaskCount: smallest.taskCount,
    bootToListenRatio:
      Math.round((largest.bootToListenMs.medianMs / smallest.bootToListenMs.medianMs) * 100) / 100,
    comparedTaskCount: largest.taskCount,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const serverEntry = path.join(projectRoot, 'dist-server', 'server', 'main.js');
  if (!existsSync(serverEntry)) {
    throw new Error(`Missing ${serverEntry}. Run "npm run build:server" first.`);
  }

  const results = [];
  for (const taskCount of options.taskCounts) {
    results.push(await profileTaskCount(taskCount, options));
  }

  const scorecard = {
    comparison: buildComparison(results),
    generatedAt: new Date().toISOString(),
    gitSubprocessWindowMs: options.gitSubprocessWindowMs,
    host: {
      arch: os.arch(),
      cpus: os.cpus().length,
      node: process.version,
      platform: os.platform(),
    },
    iterationsPerTaskCount: options.iterations,
    results,
    settledSamplesPerIteration: options.settledSamples,
  };

  const serialized = JSON.stringify(scorecard, null, 2);
  process.stdout.write(`${serialized}\n`);
  if (options.out) {
    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${serialized}\n`, 'utf8');
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
