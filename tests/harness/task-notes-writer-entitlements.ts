import {
  createTaskNotesWriterEntitlements,
  type TaskNotesProofReportIdentity,
  type TaskNotesWriterEntitlements,
  type TaskNotesWriterSurface,
} from '../../electron/ipc/task-notes-writer-entitlements.js';

function identity(surface: TaskNotesWriterSurface, seed: string): TaskNotesProofReportIdentity {
  const digest = (offset: number) =>
    ((Number.parseInt(seed, 16) + offset) % 16).toString(16).repeat(64);
  return {
    artifactDigest: digest(1),
    commandManifestDigest: digest(2),
    dependencyEdgeDigest: digest(3),
    fixtureSeedDigest: digest(4),
    formatVersion: 1,
    proofDigest: digest(5),
    relevantTreeDigest: digest(6),
    sourceManifestDigest: digest(7),
    toolchainDigest: digest(8),
    writerTrain: surface,
  };
}

/** Explicit intended-on position for adapter/service tests; production composition never imports it. */
export function createIntendedTaskNotesWriterEntitlements(
  surfaces: readonly TaskNotesWriterSurface[] = ['desktop', 'remote'],
): TaskNotesWriterEntitlements {
  const desktop = identity('desktop', '1');
  const remote = identity('remote', '2');
  return createTaskNotesWriterEntitlements({
    ...(surfaces.includes('desktop')
      ? { desktop: { promotionIdentity: desktop, reportIdentity: desktop } }
      : {}),
    ...(surfaces.includes('remote')
      ? { remote: { promotionIdentity: remote, reportIdentity: remote } }
      : {}),
  });
}
