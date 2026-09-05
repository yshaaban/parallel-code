#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  classifyDependencyExposure,
  DEPENDENCY_EXPOSURE_LANES,
  normalizeAuditNodePath,
} from './lib/dependency-exposure.mjs';
import { getCommandBin } from './lib/run-command.mjs';

export const AUDIT_ATTEMPT_TIMEOUT_MS = 60_000;
export const AUDIT_RETRY_DELAY_MS = 1_000;
export const AUDIT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
export const AUDIT_MAX_ATTEMPTS = 2;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEVERITIES = /** @type {const} */ (['info', 'low', 'moderate', 'high', 'critical']);
const SEVERITY_ORDER = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const execFileAsync = promisify(execFile);

export class AuditOperationalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuditOperationalError';
  }
}

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertSeverity(value, label) {
  if (typeof value !== 'string' || !SEVERITY_ORDER.has(value)) {
    throw new Error(`${label} has unknown severity ${String(value)}.`);
  }
  return value;
}

function getAdvisories(vulnerabilityName, vulnerability) {
  if (!Array.isArray(vulnerability.via)) {
    throw new Error(`Audit vulnerability ${vulnerabilityName} is missing via[].`);
  }
  const advisories = vulnerability.via
    .filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: String(entry.source ?? entry.url ?? entry.dependency ?? vulnerabilityName),
      title: typeof entry.title === 'string' ? entry.title : null,
      url: typeof entry.url === 'string' ? entry.url : null,
      severity:
        entry.severity === undefined
          ? null
          : assertSeverity(entry.severity, `Audit advisory ${vulnerabilityName}`),
    }));

  if (advisories.length === 0) {
    advisories.push({ id: vulnerabilityName, title: null, url: null, severity: null });
  }

  return [
    ...new Map(advisories.map((advisory) => [advisory.url ?? advisory.id, advisory])).values(),
  ].sort((left, right) => (left.url ?? left.id).localeCompare(right.url ?? right.id));
}

function isPolicyFailure(severity, memberships) {
  if (severity === 'critical' || severity === 'high') return true;
  if (severity !== 'moderate') return false;
  return memberships.some(({ lane }) => lane === 'backend-runtime' || lane === 'renderer-shipped');
}

export function parseAuditJson(stdout) {
  let auditReport;
  try {
    auditReport = JSON.parse(stdout);
  } catch (error) {
    throw new AuditOperationalError(
      `npm audit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    assertPlainRecord(auditReport, 'npm audit report');
  } catch (error) {
    throw new AuditOperationalError(
      `npm audit returned an invalid report: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (auditReport.auditReportVersion === undefined && auditReport.error !== undefined) {
    const detail =
      typeof auditReport.error === 'string' ? auditReport.error : JSON.stringify(auditReport.error);
    throw new AuditOperationalError(`npm audit reported an operational error: ${detail}`);
  }
  if (auditReport.auditReportVersion !== 2) {
    throw new AuditOperationalError(
      `npm audit report version must be 2, received ${String(auditReport.auditReportVersion)}.`,
    );
  }
  try {
    assertPlainRecord(auditReport.vulnerabilities, 'npm audit vulnerabilities');
  } catch (error) {
    throw new AuditOperationalError(
      `npm audit returned an invalid report: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return auditReport;
}

export function evaluateDependencyAudit(auditReport, exposure) {
  const vulnerabilities = assertPlainRecord(
    auditReport.vulnerabilities,
    'npm audit vulnerabilities',
  );
  const entries = [];

  for (const [vulnerabilityName, rawVulnerability] of Object.entries(vulnerabilities).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const vulnerability = assertPlainRecord(
      rawVulnerability,
      `Audit vulnerability ${vulnerabilityName}`,
    );
    const severity = assertSeverity(
      vulnerability.severity,
      `Audit vulnerability ${vulnerabilityName}`,
    );
    if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0) {
      throw new Error(`Audit vulnerability ${vulnerabilityName} is missing nodes[].`);
    }
    const advisories = getAdvisories(vulnerabilityName, vulnerability);

    for (const rawNodePath of vulnerability.nodes) {
      const nodePath = normalizeAuditNodePath(rawNodePath);
      const dependencyNode = exposure.nodesByPath.get(nodePath);
      if (!dependencyNode) {
        throw new Error(
          `Audit node is absent from the classified lock graph: ${nodePath} (${vulnerabilityName}).`,
        );
      }
      entries.push({
        vulnerabilityName,
        severity,
        nodePath,
        packageName: dependencyNode.name,
        installName: dependencyNode.installName,
        version: dependencyNode.version,
        primaryExposure: dependencyNode.primaryExposure,
        memberships: dependencyNode.memberships,
        advisories,
        fixAvailable: vulnerability.fixAvailable ?? false,
        policyFailure: isPolicyFailure(severity, dependencyNode.memberships),
      });
    }
  }

  entries.sort(
    (left, right) =>
      SEVERITY_ORDER.get(right.severity) - SEVERITY_ORDER.get(left.severity) ||
      DEPENDENCY_EXPOSURE_LANES.indexOf(left.primaryExposure) -
        DEPENDENCY_EXPOSURE_LANES.indexOf(right.primaryExposure) ||
      left.nodePath.localeCompare(right.nodePath) ||
      left.vulnerabilityName.localeCompare(right.vulnerabilityName),
  );

  const counts = Object.fromEntries(
    DEPENDENCY_EXPOSURE_LANES.map((lane) => [
      lane,
      Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])),
    ]),
  );
  for (const entry of entries) counts[entry.primaryExposure][entry.severity] += 1;

  return {
    passed: entries.every((entry) => !entry.policyFailure),
    counts,
    entries,
    policyFailures: entries.filter((entry) => entry.policyFailure),
  };
}

function terminateAuditChild(
  child,
  { platform = process.platform, processKillFn = process.kill } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      processKillFn(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct child if it exited between inspection and kill.
    }
  }
  child.kill('SIGKILL');
}

export function runNpmAuditAttempt({
  cwd = PROJECT_ROOT,
  timeoutMs = AUDIT_ATTEMPT_TIMEOUT_MS,
  outputLimitBytes = AUDIT_OUTPUT_LIMIT_BYTES,
  spawnFn = spawn,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  platform = process.platform,
  processKillFn = process.kill,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(getCommandBin('npm'), ['audit', '--json'], {
        cwd,
        detached: platform !== 'win32',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new AuditOperationalError(
          `Could not start npm audit: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    function rejectOperational(error, { terminate = false } = {}) {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timeout);
      if (terminate) terminateAuditChild(child, { platform, processKillFn });
      reject(
        error instanceof AuditOperationalError
          ? error
          : new AuditOperationalError(error instanceof Error ? error.message : String(error), {
              cause: error,
            }),
      );
    }

    const timeout = setTimeoutFn(() => {
      rejectOperational(new AuditOperationalError(`npm audit exceeded ${timeoutMs}ms.`), {
        terminate: true,
      });
    }, timeoutMs);

    function appendOutput(streamName, current, chunk) {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (current.byteLength + nextChunk.byteLength > outputLimitBytes) {
        rejectOperational(
          new AuditOperationalError(`npm audit ${streamName} exceeded ${outputLimitBytes} bytes.`),
          { terminate: true },
        );
        return current;
      }
      return Buffer.concat([current, nextChunk], current.byteLength + nextChunk.byteLength);
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput('stdout', stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput('stderr', stderr, chunk);
    });
    child.once('error', (error) => {
      rejectOperational(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timeout);
      resolve({
        code: code ?? null,
        signal: signal ?? null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
  });
}

function wait(ms, setTimeoutFn = setTimeout) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

export async function queryAuditWithRetry({
  runAttempt = runNpmAuditAttempt,
  retryDelayMs = AUDIT_RETRY_DELAY_MS,
  waitFn = wait,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= AUDIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await runAttempt({ attempt });
      if (result.signal !== null || (result.code !== 0 && result.code !== 1)) {
        const outcome =
          result.signal !== null ? `signal ${result.signal}` : `exit code ${String(result.code)}`;
        throw new AuditOperationalError(`npm audit process failed with ${outcome}.`);
      }
      return { auditReport: parseAuditJson(result.stdout), attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!(lastError instanceof AuditOperationalError)) throw lastError;
      if (attempt < AUDIT_MAX_ATTEMPTS) await waitFn(retryDelayMs);
    }
  }
  throw new Error(`npm audit failed after ${AUDIT_MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

export async function getNpmVersion({ cwd = PROJECT_ROOT, execFileFn = execFileAsync } = {}) {
  const match = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/u);
  if (match?.[1]) return match[1];

  const result = await execFileFn(getCommandBin('npm'), ['--version'], {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const version = String(result.stdout).trim();
  if (!version) throw new Error('Could not determine npm version.');
  return version;
}

export function formatAuditSummary(report) {
  const lines = ['Dependency exposure audit'];
  for (const lane of DEPENDENCY_EXPOSURE_LANES) {
    const laneCounts = report.counts[lane];
    lines.push(
      `${lane}: critical=${laneCounts.critical} high=${laneCounts.high} moderate=${laneCounts.moderate} low=${laneCounts.low} info=${laneCounts.info}`,
    );
  }
  lines.push(
    report.passed
      ? 'Policy passed.'
      : `Policy failed with ${report.policyFailures.length} vulnerable installed node(s).`,
  );
  for (const entry of report.policyFailures) {
    const memberships = entry.memberships
      .map(({ lane, dependencyPath }) => `${lane}: ${dependencyPath.join(' -> ')}`)
      .join('; ');
    const advisoryRefs = entry.advisories.map((advisory) => advisory.url ?? advisory.id).join(', ');
    lines.push(
      `- ${entry.severity} ${entry.packageName}@${entry.version} (${entry.nodePath}); ${memberships}; advisory=${advisoryRefs}; fix=${JSON.stringify(entry.fixAvailable)}`,
    );
  }
  return lines.join('\n');
}

function parseArguments(argv) {
  let jsonOutput = null;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json-output') {
      const outputPath = argv[index + 1];
      if (!outputPath || outputPath.startsWith('--')) {
        throw new Error('--json-output requires a file path.');
      }
      jsonOutput = outputPath;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { jsonOutput };
}

export function resolveAuditOutputPath(jsonOutput, cwd = PROJECT_ROOT) {
  const outputPath = path.resolve(cwd, jsonOutput);
  const artifactRoot = path.join(path.resolve(cwd), 'tmp');
  const relativePath = path.relative(artifactRoot, outputPath);
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    path.extname(relativePath) !== '.json'
  ) {
    throw new Error('--json-output must be a JSON artifact path inside tmp/.');
  }
  return outputPath;
}

export function createAuditMachineReport({
  evaluation,
  attempts,
  generatedAt,
  nodeVersion,
  npmVersion,
  lockBytes,
}) {
  return {
    generatedAt,
    nodeVersion,
    npmVersion,
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    attempts,
    ...evaluation,
  };
}

export async function runDependencyAudit({
  argv = process.argv,
  cwd = PROJECT_ROOT,
  readFileFn = readFile,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
  queryAudit,
  npmVersion,
  now = () => new Date(),
  rendererRoots,
} = {}) {
  const { jsonOutput } = parseArguments(argv);
  const lockPath = path.join(cwd, 'package-lock.json');
  const lockBytes = await readFileFn(lockPath);
  const packageLock = JSON.parse(lockBytes.toString('utf8'));
  const exposure = classifyDependencyExposure(packageLock, { rendererRoots });
  const { auditReport, attempts } = queryAudit
    ? await queryAudit()
    : await queryAuditWithRetry({ runAttempt: () => runNpmAuditAttempt({ cwd }) });
  const evaluation = evaluateDependencyAudit(auditReport, exposure);
  const machineReport = createAuditMachineReport({
    evaluation,
    attempts,
    generatedAt: now().toISOString(),
    nodeVersion: process.version,
    npmVersion: npmVersion ?? (await getNpmVersion({ cwd })),
    lockBytes,
  });

  if (jsonOutput) {
    const outputPath = resolveAuditOutputPath(jsonOutput, cwd);
    await mkdirFn(path.dirname(outputPath), { recursive: true });
    await writeFileFn(outputPath, `${JSON.stringify(machineReport, null, 2)}\n`, 'utf8');
  }

  return machineReport;
}

async function main() {
  try {
    const report = await runDependencyAudit();
    console.log(formatAuditSummary(report));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(
      `Dependency exposure audit failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
