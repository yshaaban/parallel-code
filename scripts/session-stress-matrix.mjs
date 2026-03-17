#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSessionStressMatrix,
  getSessionStressMatrixNames,
  getSessionStressProfile,
  getSessionStressProfileNames,
} from './session-stress-profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RUNNER_PATH = path.resolve(ROOT_DIR, 'scripts', 'session-stress.mjs');
const RESERVED_PASSTHROUGH_FLAGS = new Set([
  '--fail-on-budget',
  '--help',
  '--output-json',
  '--print-profiles',
  '--profile',
  '--quiet',
]);

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function defaultOutDir() {
  return path.resolve(ROOT_DIR, 'artifacts', 'session-stress', timestampForPath());
}

function resolveOutDir(input) {
  if (!input) {
    return defaultOutDir();
  }

  return path.resolve(ROOT_DIR, input);
}

function printHelp() {
  console.log(`Usage: node scripts/session-stress-matrix.mjs [options] [-- <session-stress args>]

Options:
  --profile <name>          Run one shared profile. Repeat to run multiple profiles.
  --profiles <a,b,c>        Comma-separated shared profile list.
  --matrix <name>           Run one shared matrix. Repeat to run multiple matrices.
  --matrices <a,b,c>        Comma-separated shared matrix list.
  --out-dir <path>          Directory for per-profile JSON artifacts and matrix-summary.json
  --repeats <count>         Run each selected profile this many times and aggregate the results.
  --skip-build              Reuse the existing dist-server build for every profile run
  --allow-budget-failures   Keep wrapper exit code at 0 when a profile exceeds budgets
  --list-profiles           Print available shared profiles and exit
  --list-matrices           Print available shared matrices and exit
  --help                    Print this help and exit

Pass-through:
  Arguments after -- are forwarded to scripts/session-stress.mjs after the selected profile.
  Use that to override profile defaults with generic runner flags such as --users or --terminals.
  Wrapper-managed flags are reserved and may not be passed through:
  ${Array.from(RESERVED_PASSTHROUGH_FLAGS).join(' ')}
`);
}

function parseCommaList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    allowBudgetFailures: false,
    listMatrices: false,
    listProfiles: false,
    matrices: [],
    outDir: defaultOutDir(),
    passthroughArgs: [],
    profiles: [],
    repeatCount: 1,
    skipBuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--') {
      options.passthroughArgs = argv.slice(index + 1);
      break;
    }

    switch (arg) {
      case '--profile':
        if (!next) {
          throw new Error('Missing value for --profile');
        }
        options.profiles.push(next);
        index += 1;
        break;
      case '--profiles':
        if (!next) {
          throw new Error('Missing value for --profiles');
        }
        options.profiles.push(...parseCommaList(next));
        index += 1;
        break;
      case '--matrix':
        if (!next) {
          throw new Error('Missing value for --matrix');
        }
        options.matrices.push(next);
        index += 1;
        break;
      case '--matrices':
        if (!next) {
          throw new Error('Missing value for --matrices');
        }
        options.matrices.push(...parseCommaList(next));
        index += 1;
        break;
      case '--out-dir':
      case '--output-dir':
        if (!next) {
          throw new Error(`Missing value for ${arg}`);
        }
        options.outDir = resolveOutDir(next);
        index += 1;
        break;
      case '--repeat':
      case '--repeats':
        if (!next) {
          throw new Error(`Missing value for ${arg}`);
        }
        options.repeatCount = Number(next);
        index += 1;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--allow-budget-failures':
        options.allowBudgetFailures = true;
        break;
      case '--list-profiles':
        options.listProfiles = true;
        break;
      case '--list-matrices':
        options.listMatrices = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.repeatCount) || options.repeatCount < 1) {
    throw new Error('--repeats must be a positive integer');
  }

  if (
    options.profiles.length === 0 &&
    options.matrices.length === 0 &&
    !options.listProfiles &&
    !options.listMatrices
  ) {
    options.matrices.push('smoke');
  }

  validatePassthroughArgs(options.passthroughArgs);
  return options;
}

function validatePassthroughArgs(args) {
  for (const arg of args) {
    if (RESERVED_PASSTHROUGH_FLAGS.has(arg)) {
      throw new Error(`Pass-through flag is reserved for the matrix wrapper: ${arg}`);
    }
  }
}

function printProfiles() {
  console.log('Available shared session stress profiles:');
  for (const profileName of getSessionStressProfileNames()) {
    const profile = getSessionStressProfile(profileName);
    console.log(`- ${profileName}: ${profile.description}`);
  }
}

function printMatrices() {
  console.log('Available shared session stress matrices:');
  for (const matrixName of getSessionStressMatrixNames()) {
    console.log(`- ${matrixName}: ${getSessionStressMatrix(matrixName).join(', ')}`);
  }
}

function uniqueValues(values) {
  const seen = new Set();
  const unique = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }

  return unique;
}

function resolveSelectedProfiles(profileNames, matrixNames) {
  const selectedProfiles = [];

  for (const profileName of profileNames) {
    getSessionStressProfile(profileName);
    selectedProfiles.push(profileName);
  }

  for (const matrixName of matrixNames) {
    selectedProfiles.push(...getSessionStressMatrix(matrixName));
  }

  return uniqueValues(selectedProfiles);
}

async function runRunner(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, ...args], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        signal: signal ?? null,
        stderr,
        stdout,
      });
    });
  });
}

async function readArtifact(artifactPath) {
  try {
    const raw = await readFile(artifactPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSummaryHighlight(summary, pathExpression) {
  const segments = pathExpression.split('.');
  let current = summary;

  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      return null;
    }
    current = current[segment];
  }

  return current ?? null;
}

function buildHighlights(summary) {
  if (!summary) {
    return null;
  }

  return {
    inputMs: getSummaryHighlight(summary, 'phases.input.wallClockMs'),
    lateJoinMs: getSummaryHighlight(summary, 'phases.lateJoin.wallClockMs'),
    lateJoinReplayMs: getSummaryHighlight(summary, 'phases.lateJoin.replay.wallClockMs'),
    mixedMs: getSummaryHighlight(summary, 'phases.mixed.wallClockMs'),
    outputMs: getSummaryHighlight(summary, 'phases.output.wallClockMs'),
    warmScrollbackMs: getSummaryHighlight(summary, 'phases.warmScrollback.wallClockMs'),
  };
}

function formatMetric(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return Number.isInteger(value) ? `${value}ms` : `${value.toFixed(1)}ms`;
}

function formatBudgetFailure(check) {
  if (check.min !== null && check.actual < check.min) {
    return `${check.label}: actual=${check.actual} min=${check.min}`;
  }
  if (check.max !== null && check.actual > check.max) {
    return `${check.label}: actual=${check.actual} max=${check.max}`;
  }
  return `${check.label}: actual=${check.actual}`;
}

function classifyRun(runner, artifactSummary) {
  const evaluation = artifactSummary?.evaluation ?? null;
  if (evaluation && evaluation.pass === false) {
    return 'budget-fail';
  }
  if (runner.exitCode !== 0) {
    return 'runner-fail';
  }
  if (!artifactSummary || !evaluation) {
    return 'runner-fail';
  }
  return 'pass';
}

function createRunnerArgs(options, profileName, artifactPath, canReuseBuild) {
  const runnerArgs = [
    '--profile',
    profileName,
    '--output-json',
    artifactPath,
    '--quiet',
    ...options.passthroughArgs,
  ];

  if (!options.allowBudgetFailures) {
    runnerArgs.push('--fail-on-budget');
  }
  if (canReuseBuild && !runnerArgs.includes('--skip-build')) {
    runnerArgs.push('--skip-build');
  }

  return runnerArgs;
}

function formatProfileRunLabel(result) {
  if (result.repeatCount <= 1) {
    return result.profile;
  }

  return `${result.profile} run=${result.runIndex}/${result.repeatCount}`;
}

function printProfileSummary(result) {
  const highlights = result.highlights;
  const timingSummary = highlights
    ? `output=${formatMetric(highlights.outputMs)} input=${formatMetric(highlights.inputMs)} mixed=${formatMetric(highlights.mixedMs)} lateJoin=${formatMetric(highlights.lateJoinMs)} replay=${formatMetric(highlights.lateJoinReplayMs)}`
    : 'no-metrics';

  console.log(
    `[session-stress-matrix] profile=${formatProfileRunLabel(result)} status=${result.status.toUpperCase()} ${timingSummary} artifact=${result.artifactPath}`,
  );

  if (result.status === 'budget-fail' && result.evaluation) {
    for (const check of result.evaluation.checks.filter((entry) => !entry.pass)) {
      console.log(
        `[session-stress-matrix] budget-fail ${formatProfileRunLabel(result)} ${formatBudgetFailure(check)}`,
      );
    }
  }

  for (const suspect of result.topSuspects.slice(0, 3)) {
    console.log(
      `[session-stress-matrix] suspect profile=${formatProfileRunLabel(result)} area=${suspect.area} metric=${suspect.metric} value=${suspect.value}`,
    );
  }

  if (result.status === 'runner-fail') {
    console.log(
      `[session-stress-matrix] runner-fail profile=${formatProfileRunLabel(result)} exit=${result.runnerExitCode} signal=${result.runnerSignal ?? 'none'}`,
    );
  }
}

function getAverage(values) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function buildAggregatedHighlights(results) {
  const highlightKeys = [
    ['inputMs', 'inputMs'],
    ['lateJoinMs', 'lateJoinMs'],
    ['lateJoinReplayMs', 'lateJoinReplayMs'],
    ['mixedMs', 'mixedMs'],
    ['outputMs', 'outputMs'],
  ];
  const aggregated = {};

  for (const [property, key] of highlightKeys) {
    const values = results
      .map((result) => result.highlights?.[key])
      .filter((value) => typeof value === 'number');
    aggregated[property] = getAverage(values);
  }

  return aggregated;
}

function buildProfileSummaries(results) {
  const summariesByProfile = new Map();

  for (const result of results) {
    let summary = summariesByProfile.get(result.profile);
    if (!summary) {
      summary = {
        artifactPaths: [],
        description: result.description,
        profile: result.profile,
        repeatCount: result.repeatCount,
        runs: [],
        statusCounts: {
          'budget-fail': 0,
          pass: 0,
          'runner-fail': 0,
        },
      };
      summariesByProfile.set(result.profile, summary);
    }

    summary.runs.push(result.runIndex);
    summary.artifactPaths.push(result.artifactPath);
    summary.statusCounts[result.status] += 1;
  }

  return Array.from(summariesByProfile.values()).map((summary) => {
    const runs = results.filter((result) => result.profile === summary.profile);
    let overallStatus = 'budget-fail';
    if (runs.every((result) => result.status === 'pass')) {
      overallStatus = 'pass';
    } else if (runs.some((result) => result.status === 'runner-fail')) {
      overallStatus = 'runner-fail';
    }

    return {
      ...summary,
      averageHighlights: buildAggregatedHighlights(runs),
      overallStatus,
    };
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exit(1);
  }

  if (options.listProfiles) {
    printProfiles();
  }
  if (options.listMatrices) {
    printMatrices();
  }
  if (options.listProfiles || options.listMatrices) {
    return;
  }

  const selectedProfiles = resolveSelectedProfiles(options.profiles, options.matrices);
  await mkdir(options.outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  console.log(
    `[session-stress-matrix] outDir=${options.outDir} profiles=${selectedProfiles.join(', ')} repeats=${options.repeatCount}`,
  );

  const results = [];
  let canReuseBuild = options.skipBuild || options.passthroughArgs.includes('--skip-build');

  for (const profileName of selectedProfiles) {
    for (let runIndex = 1; runIndex <= options.repeatCount; runIndex += 1) {
      const artifactFileName =
        options.repeatCount === 1 ? `${profileName}.json` : `${profileName}.run-${runIndex}.json`;
      const artifactPath = path.resolve(options.outDir, artifactFileName);
      await rm(artifactPath, { force: true });
      const runnerArgs = createRunnerArgs(options, profileName, artifactPath, canReuseBuild);

      console.log(
        `[session-stress-matrix] running profile=${profileName} run=${runIndex}/${options.repeatCount}`,
      );
      const runner = await runRunner(runnerArgs);
      const artifactSummary = await readArtifact(artifactPath);
      const status = classifyRun(runner, artifactSummary);
      const highlights = buildHighlights(artifactSummary);
      const evaluation = artifactSummary?.evaluation ?? null;
      const topSuspects = artifactSummary?.analysis?.topSuspects ?? [];

      if (!canReuseBuild && (runner.exitCode === 0 || artifactSummary)) {
        canReuseBuild = true;
      }

      const result = {
        artifactPath,
        description: getSessionStressProfile(profileName).description,
        evaluation,
        highlights,
        profile: profileName,
        repeatCount: options.repeatCount,
        runIndex,
        runnerExitCode: runner.exitCode,
        runnerSignal: runner.signal,
        status,
        topSuspects,
      };

      results.push(result);
      printProfileSummary(result);
    }
  }

  const profileSummaries = buildProfileSummaries(results);

  const matrixSummary = {
    artifactVersion: 1,
    finishedAt: new Date().toISOString(),
    outDir: options.outDir,
    overallStatus: results.every(
      (result) =>
        result.status === 'pass' ||
        (options.allowBudgetFailures && result.status === 'budget-fail'),
    )
      ? 'pass'
      : 'fail',
    profileSummaries,
    profileResults: results,
    repeatCount: options.repeatCount,
    selectedMatrices: uniqueValues(options.matrices),
    selectedProfiles,
    startedAt,
  };

  const matrixSummaryPath = path.resolve(options.outDir, 'matrix-summary.json');
  await writeFile(matrixSummaryPath, `${JSON.stringify(matrixSummary, null, 2)}\n`, 'utf8');
  console.log(
    `[session-stress-matrix] overall=${matrixSummary.overallStatus.toUpperCase()} summary=${matrixSummaryPath}`,
  );

  const hasRunnerFailures = results.some((result) => result.status === 'runner-fail');
  const hasBudgetFailures = results.some((result) => result.status === 'budget-fail');
  process.exitCode =
    hasRunnerFailures || (!options.allowBudgetFailures && hasBudgetFailures) ? 1 : 0;
}

await main();
