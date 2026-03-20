import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { createBrowserServerClient } from './browser-server-client.mjs';

const DEFAULT_AUTH_TOKEN = 'parallel-code-local-browser';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_SAMPLE_FILES = 5;
const DEFAULT_WARM_RUNS = 3;

function parseArgs(argv) {
  const options = {
    authToken: process.env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    branchName: process.env.BRANCH_NAME,
    files: [],
    mode: process.env.REVIEW_DIFF_MODE ?? 'all',
    projectRoot: process.env.PROJECT_ROOT,
    sampleFiles: Number.parseInt(
      process.env.REVIEW_DIFF_SAMPLE_FILES ?? `${DEFAULT_SAMPLE_FILES}`,
      10,
    ),
    serverUrl: process.env.SERVER_URL ?? DEFAULT_SERVER_URL,
    warmRuns: Number.parseInt(process.env.REVIEW_DIFF_WARM_RUNS ?? `${DEFAULT_WARM_RUNS}`, 10),
    worktreePath: process.env.WORKTREE_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--auth-token') {
      options.authToken = argv[index + 1] ?? options.authToken;
      index += 1;
      continue;
    }

    if (arg === '--branch-name') {
      options.branchName = argv[index + 1] ?? options.branchName;
      index += 1;
      continue;
    }

    if (arg === '--file') {
      const filePath = argv[index + 1];
      if (filePath) {
        options.files.push(filePath);
      }
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      options.mode = argv[index + 1] ?? options.mode;
      index += 1;
      continue;
    }

    if (arg === '--project-root') {
      options.projectRoot = argv[index + 1] ?? options.projectRoot;
      index += 1;
      continue;
    }

    if (arg === '--sample-files') {
      options.sampleFiles = Number.parseInt(argv[index + 1] ?? `${options.sampleFiles}`, 10);
      index += 1;
      continue;
    }

    if (arg === '--server-url') {
      options.serverUrl = argv[index + 1] ?? options.serverUrl;
      index += 1;
      continue;
    }

    if (arg === '--warm-runs') {
      options.warmRuns = Number.parseInt(argv[index + 1] ?? `${options.warmRuns}`, 10);
      index += 1;
      continue;
    }

    if (arg === '--worktree-path') {
      options.worktreePath = argv[index + 1] ?? options.worktreePath;
      index += 1;
    }
  }

  if (!options.worktreePath) {
    throw new Error('Missing worktree path. Pass --worktree-path or set WORKTREE_PATH.');
  }

  return options;
}

function roundMilliseconds(value) {
  return Number(value.toFixed(1));
}

async function measureInvoke(client, channel, body) {
  const startedAt = performance.now();
  const result = await client.invokeIpc(channel, body);
  return {
    elapsedMs: roundMilliseconds(performance.now() - startedAt),
    result,
  };
}

function summarizeTimings(values) {
  if (values.length === 0) {
    return {
      averageMs: null,
      maxMs: null,
      minMs: null,
    };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    averageMs: roundMilliseconds(total / values.length),
    maxMs: roundMilliseconds(Math.max(...values)),
    minMs: roundMilliseconds(Math.min(...values)),
  };
}

function resolveSampleFiles(files, explicitFiles, sampleFiles) {
  if (explicitFiles.length > 0) {
    return explicitFiles
      .map((filePath) => files.find((file) => file.path === filePath))
      .filter((file) => file !== undefined);
  }

  return files.slice(0, sampleFiles);
}

function getFileDiffRequest(file, options) {
  if (file.committed && options.branchName && options.projectRoot) {
    return {
      body: {
        branchName: options.branchName,
        filePath: file.path,
        projectRoot: options.projectRoot,
      },
      channel: 'get_file_diff_from_branch',
    };
  }

  return {
    body: {
      filePath: file.path,
      status: file.status,
      worktreePath: options.worktreePath,
    },
    channel: 'get_file_diff',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = createBrowserServerClient({
    authToken: options.authToken,
    serverUrl: options.serverUrl,
  });

  const coldProject = await measureInvoke(client, 'get_project_diff', {
    mode: options.mode,
    worktreePath: options.worktreePath,
  });
  const warmProjectRuns = [];

  for (let run = 0; run < options.warmRuns; run += 1) {
    const result = await measureInvoke(client, 'get_project_diff', {
      mode: options.mode,
      worktreePath: options.worktreePath,
    });
    warmProjectRuns.push(result.elapsedMs);
  }

  const sampleFiles = resolveSampleFiles(
    coldProject.result.files,
    options.files,
    options.sampleFiles,
  );
  const fileDiffs = [];

  for (const file of sampleFiles) {
    const request = getFileDiffRequest(file, options);
    const coldFileDiff = await measureInvoke(client, request.channel, request.body);
    const warmFileRuns = [];

    for (let run = 0; run < options.warmRuns; run += 1) {
      const result = await measureInvoke(client, request.channel, request.body);
      warmFileRuns.push(result.elapsedMs);
    }

    fileDiffs.push({
      channel: request.channel,
      coldMs: coldFileDiff.elapsedMs,
      path: file.path,
      status: file.status,
      warmRunsMs: warmFileRuns,
      warmSummary: summarizeTimings(warmFileRuns),
    });
  }

  const summary = {
    fileDiffs,
    projectDiff: {
      coldMs: coldProject.elapsedMs,
      fileCount: coldProject.result.files.length,
      mode: options.mode,
      warmRunsMs: warmProjectRuns,
      warmSummary: summarizeTimings(warmProjectRuns),
    },
    worktreePath: options.worktreePath,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
