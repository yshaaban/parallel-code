#!/usr/bin/env node

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PROFILE = 'smoke';
const DEFAULT_LATEST_COUNT = 3;
const ARTIFACT_ROOT = path.resolve('artifacts', 'performance-scorecard');

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseScorecardSummaryArgs(args) {
  const options = {
    latest: DEFAULT_LATEST_COUNT,
    profile: DEFAULT_PROFILE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--latest':
        options.latest = parsePositiveInteger(next, DEFAULT_LATEST_COUNT);
        index += 1;
        break;
      case '--profile':
        options.profile = typeof next === 'string' && next.length > 0 ? next : DEFAULT_PROFILE;
        index += 1;
        break;
      default:
        throw new Error(`Unknown performance scorecard summary option: ${arg}`);
    }
  }

  return options;
}

function getPercentileValue(values, fraction) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function getMetricKey(metric) {
  return `${metric.journey}\u0000${metric.name}`;
}

function isScorecardArtifact(profile, fileName) {
  return fileName.startsWith(`${profile}-`) && fileName.endsWith('.json');
}

async function listLatestScorecardFiles(profile, latest) {
  const dir = path.join(ARTIFACT_ROOT, profile);
  const entries = await readdir(dir).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => isScorecardArtifact(profile, entry))
      .map(async (entry) => {
        const filePath = path.join(dir, entry);
        const stats = await stat(filePath);
        return { filePath, mtimeMs: stats.mtimeMs };
      }),
  );

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, latest)
    .map((entry) => entry.filePath);
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function summarizeScorecardRuns(runs) {
  const metricsByKey = new Map();

  for (const run of runs) {
    for (const metric of run.metrics ?? []) {
      const key = getMetricKey(metric);
      const entry = metricsByKey.get(key) ?? {
        budgetMs: metric.budgetMs,
        journey: metric.journey,
        name: metric.name,
        unit: metric.unit,
        values: [],
      };
      entry.values.push(metric.value);
      metricsByKey.set(key, entry);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    profile: runs[0]?.profile ?? DEFAULT_PROFILE,
    runCount: runs.length,
    runs: runs.map((run) => ({
      artifactBaseName: run.artifactBaseName,
      completedAt: run.completedAt,
      commit: run.environment?.commit ?? null,
      startedAt: run.startedAt,
    })),
    metrics: Array.from(metricsByKey.values()).map((entry) => {
      const p50 = roundMetric(getPercentileValue(entry.values, 0.5));
      const p95 = roundMetric(getPercentileValue(entry.values, 0.95));
      const max = roundMetric(Math.max(...entry.values));
      return {
        budgetMs: entry.budgetMs,
        count: entry.values.length,
        journey: entry.journey,
        max,
        min: roundMetric(Math.min(...entry.values)),
        name: entry.name,
        p50,
        p95,
        status: getMetricStatus(entry, p95),
        unit: entry.unit,
      };
    }),
  };
}

function formatValue(value, unit) {
  return unit === 'ms' ? `${value.toFixed(2)}ms` : String(value);
}

function formatBudget(metric) {
  if (metric.budgetMs === undefined) {
    return 'unbudgeted';
  }

  return metric.unit === 'ms' ? `${metric.budgetMs}ms` : String(metric.budgetMs);
}

function getMetricStatus(entry, p95) {
  if (entry.budgetMs === undefined) {
    return 'unbudgeted';
  }

  if (p95 <= entry.budgetMs) {
    return 'pass';
  }

  return 'provisional-fail';
}

export function formatScorecardSummaryMarkdown(summary) {
  const lines = [
    `# Performance Scorecard Summary (${summary.profile})`,
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Runs: ${summary.runCount}`,
    '',
    '| Journey | Metric | Samples | p50 | p95 | Max | Budget | Status |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...summary.metrics.map(
      (metric) =>
        `| ${metric.journey} | ${metric.name} | ${metric.count} | ${formatValue(metric.p50, metric.unit)} | ${formatValue(
          metric.p95,
          metric.unit,
        )} | ${formatValue(metric.max, metric.unit)} | ${formatBudget(metric)} | ${metric.status} |`,
    ),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

async function writeSummaryArtifacts(summary) {
  const artifactDir = path.join(ARTIFACT_ROOT, summary.profile);
  const safeGeneratedAt = summary.generatedAt.replace(/[:.]/gu, '-');
  const jsonPath = path.join(artifactDir, `summary-${safeGeneratedAt}.json`);
  const markdownPath = path.join(artifactDir, `summary-${safeGeneratedAt}.md`);
  const json = JSON.stringify(summary, null, 2);
  const markdown = formatScorecardSummaryMarkdown(summary);

  await mkdir(artifactDir, { recursive: true });
  await Promise.all([writeFile(jsonPath, json, 'utf8'), writeFile(markdownPath, markdown, 'utf8')]);
  return { jsonPath, markdown, markdownPath };
}

export async function runScorecardSummary(options) {
  const filePaths = await listLatestScorecardFiles(options.profile, options.latest);
  if (filePaths.length === 0) {
    throw new Error(`No performance scorecard ${options.profile} artifacts found`);
  }

  const runs = await Promise.all(filePaths.map(readJsonFile));
  const summary = summarizeScorecardRuns(runs);
  return writeSummaryArtifacts(summary);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runScorecardSummary(parseScorecardSummaryArgs(process.argv.slice(2)))
    .then(({ markdown, markdownPath }) => {
      console.log(markdown.trimEnd());
      console.log(`\nWrote ${path.relative(process.cwd(), markdownPath)}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
