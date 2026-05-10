import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';

export type ScorecardStatus = 'pass' | 'provisional-fail' | 'unbudgeted';

export interface ScorecardMetric {
  budgetMs?: number;
  journey: string;
  name: string;
  status: ScorecardStatus;
  unit: 'ms' | 'count';
  value: number;
}

export interface ScorecardRun {
  artifactBaseName: string;
  completedAt: string | null;
  diagnostics: Record<string, unknown>;
  environment: {
    browserName: string;
    commit: string | null;
    node: string;
    os: string;
    platform: string;
    workerIndex: number;
  };
  metrics: ScorecardMetric[];
  profile: 'smoke';
  startedAt: string;
}

interface CreateScorecardRunOptions {
  browserName: string;
  profile: ScorecardRun['profile'];
  testInfo: Pick<TestInfo, 'parallelIndex' | 'workerIndex'>;
}

interface RecordMetricOptions {
  budgetMs?: number;
  journey: string;
  name: string;
  unit?: ScorecardMetric['unit'];
  value: number;
}

function getCurrentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function createArtifactBaseName(
  profile: ScorecardRun['profile'],
  testInfo: Pick<TestInfo, 'parallelIndex'>,
): string {
  const safeStartedAt = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${profile}-${safeStartedAt}-p${testInfo.parallelIndex}`;
}

export function createScorecardRun(options: CreateScorecardRunOptions): ScorecardRun {
  return {
    artifactBaseName: createArtifactBaseName(options.profile, options.testInfo),
    completedAt: null,
    diagnostics: {},
    environment: {
      browserName: options.browserName,
      commit: getCurrentCommit(),
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      workerIndex: options.testInfo.workerIndex,
    },
    metrics: [],
    profile: options.profile,
    startedAt: new Date().toISOString(),
  };
}

function getMetricStatus(value: number, budgetMs: number | undefined): ScorecardStatus {
  if (budgetMs === undefined) {
    return 'unbudgeted';
  }

  return value <= budgetMs ? 'pass' : 'provisional-fail';
}

export function recordScorecardMetric(
  run: ScorecardRun,
  options: RecordMetricOptions,
): ScorecardMetric {
  const metric = {
    budgetMs: options.budgetMs,
    journey: options.journey,
    name: options.name,
    status: getMetricStatus(options.value, options.budgetMs),
    unit: options.unit ?? 'ms',
    value: Math.round(options.value * 100) / 100,
  } satisfies ScorecardMetric;
  run.metrics.push(metric);
  return metric;
}

function formatMetricValue(metric: ScorecardMetric): string {
  return metric.unit === 'ms' ? `${metric.value.toFixed(2)}ms` : String(metric.value);
}

function formatBudget(metric: ScorecardMetric): string {
  if (metric.budgetMs === undefined) {
    return 'unbudgeted';
  }

  return metric.unit === 'ms' ? `${metric.budgetMs}ms` : String(metric.budgetMs);
}

export function formatScorecardMarkdown(run: ScorecardRun): string {
  const lines = [
    `# Performance Scorecard (${run.profile})`,
    '',
    `- Started: ${run.startedAt}`,
    `- Completed: ${run.completedAt ?? 'not completed'}`,
    `- Commit: ${run.environment.commit ?? 'unknown'}`,
    `- Browser: ${run.environment.browserName}`,
    `- Node: ${run.environment.node}`,
    `- Host: ${run.environment.os}`,
    '',
    '| Journey | Metric | Value | Budget | Status |',
    '| --- | --- | ---: | ---: | --- |',
    ...run.metrics.map(
      (metric) =>
        `| ${metric.journey} | ${metric.name} | ${formatMetricValue(metric)} | ${formatBudget(
          metric,
        )} | ${metric.status} |`,
    ),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

async function writeArtifact(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

export async function writeScorecardArtifacts(
  testInfo: TestInfo,
  run: ScorecardRun,
): Promise<void> {
  run.completedAt = new Date().toISOString();
  const artifactDir = path.resolve('artifacts', 'performance-scorecard', run.profile);
  const json = JSON.stringify(run, null, 2);
  const markdown = formatScorecardMarkdown(run);
  const jsonPath = path.join(artifactDir, `${run.artifactBaseName}.json`);
  const markdownPath = path.join(artifactDir, `${run.artifactBaseName}.md`);

  await Promise.all([writeArtifact(jsonPath, json), writeArtifact(markdownPath, markdown)]);
  await testInfo.attach('performance-scorecard.json', {
    body: json,
    contentType: 'application/json',
  });
  await testInfo.attach('performance-scorecard.md', {
    body: markdown,
    contentType: 'text/markdown',
  });
}
