import { isRecord } from '../../src/lib/type-guards.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type TaskNotesWriterSurface = 'desktop' | 'remote';

export interface TaskNotesProofReportIdentity {
  readonly artifactDigest: string;
  readonly commandManifestDigest: string;
  readonly dependencyEdgeDigest: string;
  readonly fixtureSeedDigest: string;
  readonly formatVersion: 1;
  readonly proofDigest: string;
  readonly relevantTreeDigest: string;
  readonly sourceManifestDigest: string;
  readonly toolchainDigest: string;
  readonly writerTrain: TaskNotesWriterSurface;
}

export interface TaskNotesWriterProofEvidence {
  /** Identity archived by the successful full-gate report. */
  readonly reportIdentity: unknown;
  /** Independently recomputed identity for the artifact being promoted. */
  readonly promotionIdentity: unknown;
}

export interface TaskNotesWriterEntitlement {
  readonly proofReportIdentity: TaskNotesProofReportIdentity | null;
  readonly surface: TaskNotesWriterSurface;
  readonly write: boolean;
}

export interface TaskNotesWriterEntitlements {
  readonly desktop: TaskNotesWriterEntitlement;
  readonly remote: TaskNotesWriterEntitlement;
}

const issuedEntitlements = new WeakSet<object>();

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key));
}

function parseProofReportIdentity(value: unknown): TaskNotesProofReportIdentity | null {
  const keys = [
    'artifactDigest',
    'commandManifestDigest',
    'dependencyEdgeDigest',
    'fixtureSeedDigest',
    'formatVersion',
    'proofDigest',
    'relevantTreeDigest',
    'sourceManifestDigest',
    'toolchainDigest',
    'writerTrain',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys) || value.formatVersion !== 1) return null;
  if (value.writerTrain !== 'desktop' && value.writerTrain !== 'remote') return null;
  for (const key of keys) {
    if (key === 'formatVersion' || key === 'writerTrain') continue;
    if (typeof value[key] !== 'string' || !SHA256_PATTERN.test(value[key])) return null;
  }
  return Object.freeze({
    artifactDigest: value.artifactDigest as string,
    commandManifestDigest: value.commandManifestDigest as string,
    dependencyEdgeDigest: value.dependencyEdgeDigest as string,
    fixtureSeedDigest: value.fixtureSeedDigest as string,
    formatVersion: 1,
    proofDigest: value.proofDigest as string,
    relevantTreeDigest: value.relevantTreeDigest as string,
    sourceManifestDigest: value.sourceManifestDigest as string,
    toolchainDigest: value.toolchainDigest as string,
    writerTrain: value.writerTrain,
  });
}

function identitiesMatch(
  report: TaskNotesProofReportIdentity,
  promotion: TaskNotesProofReportIdentity,
): boolean {
  return (
    report.writerTrain === promotion.writerTrain &&
    report.proofDigest === promotion.proofDigest &&
    report.artifactDigest === promotion.artifactDigest &&
    report.commandManifestDigest === promotion.commandManifestDigest &&
    report.dependencyEdgeDigest === promotion.dependencyEdgeDigest &&
    report.fixtureSeedDigest === promotion.fixtureSeedDigest &&
    report.relevantTreeDigest === promotion.relevantTreeDigest &&
    report.sourceManifestDigest === promotion.sourceManifestDigest &&
    report.toolchainDigest === promotion.toolchainDigest
  );
}

function issueEntitlement(
  surface: TaskNotesWriterSurface,
  evidence?: TaskNotesWriterProofEvidence,
): TaskNotesWriterEntitlement {
  const report = parseProofReportIdentity(evidence?.reportIdentity);
  const promotion = parseProofReportIdentity(evidence?.promotionIdentity);
  const proofReportIdentity =
    report && promotion && report.writerTrain === surface && identitiesMatch(report, promotion)
      ? report
      : null;
  const entitlement = Object.freeze({
    proofReportIdentity,
    surface,
    write: proofReportIdentity !== null,
  });
  issuedEntitlements.add(entitlement);
  return entitlement;
}

/**
 * Composition-owned immutable cutover state. Missing, malformed, cross-surface, or unequal proof
 * evidence independently leaves that surface dark.
 */
export function createTaskNotesWriterEntitlements(
  evidence: {
    readonly desktop?: TaskNotesWriterProofEvidence;
    readonly remote?: TaskNotesWriterProofEvidence;
  } = {},
): TaskNotesWriterEntitlements {
  return Object.freeze({
    desktop: issueEntitlement('desktop', evidence.desktop),
    remote: issueEntitlement('remote', evidence.remote),
  });
}

/** Runtime consumers reject structurally forged lookalikes in addition to checking the surface. */
export function isTaskNotesWriterEntitled(
  entitlement: TaskNotesWriterEntitlement | undefined,
  surface: TaskNotesWriterSurface,
): boolean {
  return (
    entitlement !== undefined &&
    issuedEntitlements.has(entitlement) &&
    entitlement.surface === surface &&
    entitlement.write &&
    entitlement.proofReportIdentity?.writerTrain === surface
  );
}

export const DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS = createTaskNotesWriterEntitlements();

/** Capture composition input once so later outer-object replacement cannot change a cutover. */
export function snapshotTaskNotesWriterEntitlements(
  entitlements: TaskNotesWriterEntitlements = DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS,
): TaskNotesWriterEntitlements {
  return Object.freeze({
    desktop: entitlements.desktop,
    remote: entitlements.remote,
  });
}
