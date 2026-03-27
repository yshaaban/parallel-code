#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SESSION_STRESS_RUNNER = path.resolve(ROOT_DIR, 'scripts', 'session-stress.mjs');
const VITEST_BENCHMARK_CONFIG = path.resolve(ROOT_DIR, 'vitest.benchmark.config.ts');

const DEFAULT_PROFILES = [
  'steady_fanout',
  'verbose_bulk_text',
  'verbose_statusline',
  'verbose_mixed_agents',
  'interactive_verbose',
  'steady_verbose_agents_24',
  'heavy_tui',
];

function createTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function defaultOutputDirectory() {
  return path.resolve(ROOT_DIR, 'artifacts', 'terminal-steady-state', createTimestampForPath());
}

function parseTerminalCounts(value) {
  return value
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function parseArgs(argv) {
  const options = {
    iterations: 24,
    outDir: defaultOutputDirectory(),
    profiles: [...DEFAULT_PROFILES],
    skipBuild: false,
    terminalCounts: [6, 12, 24, 32],
    users: 6,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--terminals':
      case '--terminal-counts':
        if (!next) {
          throw new Error(`Missing value for ${arg}`);
        }
        options.terminalCounts = parseTerminalCounts(next);
        index += 1;
        break;
      case '--users':
        if (!next) {
          throw new Error('Missing value for --users');
        }
        options.users = Number(next);
        index += 1;
        break;
      case '--iterations':
        if (!next) {
          throw new Error('Missing value for --iterations');
        }
        options.iterations = Number(next);
        index += 1;
        break;
      case '--profiles':
        if (!next) {
          throw new Error('Missing value for --profiles');
        }
        options.profiles = next
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--out-dir':
        if (!next) {
          throw new Error('Missing value for --out-dir');
        }
        options.outDir = path.resolve(ROOT_DIR, next);
        index += 1;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error('--iterations must be a positive integer');
  }
  if (!Number.isInteger(options.users) || options.users <= 0) {
    throw new Error('--users must be a positive integer');
  }
  if (options.terminalCounts.length === 0) {
    throw new Error('--terminals must include at least one positive integer');
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/terminal-steady-state-benchmark.mjs [options]

Options:
  --terminals <a,b,c>   Terminal counts to benchmark (default: 6,12,24,32)
  --users <n>           Shared-session user count for the stress runs (default: 6)
  --iterations <n>      Renderer microbenchmark iterations (default: 24)
  --profiles <a,b,c>    Session-stress profiles to run (default: ${DEFAULT_PROFILES.join(',')})
  --out-dir <path>      Artifact directory (default: artifacts/terminal-steady-state/<timestamp>)
  --skip-build          Reuse the existing server build
  --help                Print this help and exit
`);
}

async function runCommand(label, command, args, env = process.env) {
  console.log(`[steady-state] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env,
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
    child.on('close', (exitCode) => {
      if ((exitCode ?? 1) !== 0) {
        reject(new Error(`${label} failed with exit code ${exitCode ?? 1}\n${stderr}`));
        return;
      }
      resolve({ stderr, stdout });
    });
  });
}

async function maybeBuildBrowserArtifacts(skipBuild) {
  if (skipBuild) {
    return;
  }

  await runCommand('prepare:browser-artifacts', 'npm', ['run', 'prepare:browser-artifacts']);
}

async function runRendererBenchmarks(options, rendererOutDir) {
  await mkdir(rendererOutDir, { recursive: true });
  await runCommand(
    'renderer microbenchmarks',
    'npm',
    ['exec', 'vitest', '--', 'run', '--config', VITEST_BENCHMARK_CONFIG],
    {
      ...process.env,
      TERMINAL_BENCH_ITERATIONS: String(options.iterations),
      TERMINAL_BENCH_OUTPUT_DIR: rendererOutDir,
      TERMINAL_BENCH_TERMINAL_COUNTS: options.terminalCounts.join(','),
    },
  );
}

async function runSessionStressMatrix(options, stressOutDir) {
  await mkdir(stressOutDir, { recursive: true });
  const results = [];

  for (const profile of options.profiles) {
    for (const terminalCount of options.terminalCounts) {
      const artifactPath = path.resolve(stressOutDir, `${profile}-${terminalCount}.json`);
      const args = [
        SESSION_STRESS_RUNNER,
        '--profile',
        profile,
        '--terminals',
        String(terminalCount),
        '--users',
        String(options.users),
        '--output-json',
        artifactPath,
        '--quiet',
      ];
      if (options.skipBuild) {
        args.push('--skip-build');
      }

      await runCommand(
        `session-stress profile=${profile} terminals=${terminalCount}`,
        process.execPath,
        args,
      );

      const rawArtifact = await readFile(artifactPath, 'utf8');
      const summary = JSON.parse(rawArtifact);
      results.push({
        artifactPath,
        phases: {
          bulkTextMs: summary.phases?.bulkText?.wallClockMs ?? 0,
          inputMs: summary.phases?.input?.wallClockMs ?? 0,
          mixedMs: summary.phases?.mixed?.wallClockMs ?? 0,
          outputMs: summary.phases?.output?.wallClockMs ?? 0,
          redrawMs: summary.phases?.redraw?.wallClockMs ?? 0,
        },
        profile,
        suspects: summary.analysis?.topSuspects ?? [],
        terminals: terminalCount,
      });
    }
  }

  return results;
}

function createMarkdownSummary(summary) {
  const lines = ['# Terminal Steady-State Benchmark Summary', ''];

  lines.push('## Specialized Microbenchmarks');
  for (const rendererResult of summary.rendererArtifacts) {
    lines.push(`- ${rendererResult}`);
  }
  lines.push('');
  lines.push('## Session Stress Runs');

  for (const result of summary.sessionStressRuns) {
    lines.push(
      `- ${result.profile} @ ${result.terminals} terminals: output=${result.phases.outputMs}ms bulkText=${result.phases.bulkTextMs}ms redraw=${result.phases.redrawMs}ms input=${result.phases.inputMs}ms mixed=${result.phases.mixedMs}ms`,
    );
    if (Array.isArray(result.suspects) && result.suspects.length > 0) {
      lines.push(`  suspects: ${result.suspects.map((suspect) => suspect.area).join(', ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rendererOutDir = path.resolve(options.outDir, 'renderer');
  const stressOutDir = path.resolve(options.outDir, 'session-stress');

  await mkdir(options.outDir, { recursive: true });
  await maybeBuildBrowserArtifacts(options.skipBuild);
  await runRendererBenchmarks(options, rendererOutDir);
  const sessionStressRuns = await runSessionStressMatrix(options, stressOutDir);

  const rendererArtifacts = [
    path.resolve(rendererOutDir, 'terminal-attach-scheduler.json'),
    path.resolve(rendererOutDir, 'agent-output-activity.json'),
    path.resolve(rendererOutDir, 'scrollback-restore.json'),
    path.resolve(rendererOutDir, 'terminal-output-history.json'),
    path.resolve(rendererOutDir, 'terminal-output-pipeline.json'),
    path.resolve(rendererOutDir, 'terminal-output-scheduler.json'),
  ];
  const summary = {
    generatedAt: new Date().toISOString(),
    options,
    rendererArtifacts,
    sessionStressRuns,
  };

  await writeFile(
    path.resolve(options.outDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.resolve(options.outDir, 'summary.md'),
    createMarkdownSummary(summary),
    'utf8',
  );

  console.log(`[steady-state] artifacts written to ${options.outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
