import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DurationSummary {
  avgMs: number;
  iterations: number;
  maxMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
}

export function parseBenchmarkTerminalCounts(
  fallbackCounts: readonly number[] = [6, 12, 24, 32],
): number[] {
  const raw = process.env.TERMINAL_BENCH_TERMINAL_COUNTS;
  if (!raw) {
    return [...fallbackCounts];
  }

  const parsedCounts = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (parsedCounts.length === 0) {
    return [...fallbackCounts];
  }

  return parsedCounts;
}

export function parseBenchmarkIterationCount(fallbackIterations: number): number {
  const raw = Number(process.env.TERMINAL_BENCH_ITERATIONS ?? '');
  if (!Number.isInteger(raw) || raw <= 0) {
    return fallbackIterations;
  }

  return raw;
}

export function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeDurations(durationsMs: readonly number[]): DurationSummary {
  const sortedDurations = [...durationsMs].sort((left, right) => left - right);
  const totalMs = sortedDurations.reduce((total, value) => total + value, 0);

  function getPercentile(fraction: number): number {
    if (sortedDurations.length === 0) {
      return 0;
    }

    const index = Math.min(
      sortedDurations.length - 1,
      Math.max(0, Math.ceil(sortedDurations.length * fraction) - 1),
    );
    return roundMilliseconds(sortedDurations[index] ?? 0);
  }

  if (sortedDurations.length === 0) {
    return {
      avgMs: 0,
      iterations: 0,
      maxMs: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      totalMs: 0,
    };
  }

  return {
    avgMs: roundMilliseconds(totalMs / sortedDurations.length),
    iterations: sortedDurations.length,
    maxMs: roundMilliseconds(sortedDurations[sortedDurations.length - 1] ?? 0),
    minMs: roundMilliseconds(sortedDurations[0] ?? 0),
    p50Ms: getPercentile(0.5),
    p95Ms: getPercentile(0.95),
    totalMs: roundMilliseconds(totalMs),
  };
}

export async function writeBenchmarkArtifact(filename: string, payload: unknown): Promise<void> {
  const outputDirectory = process.env.TERMINAL_BENCH_OUTPUT_DIR;
  if (!outputDirectory) {
    return;
  }

  const artifactPath = path.resolve(outputDirectory, filename);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
