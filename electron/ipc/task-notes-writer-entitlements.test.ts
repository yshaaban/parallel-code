import { describe, expect, it } from 'vitest';

import {
  createTaskNotesWriterEntitlements,
  isTaskNotesWriterEntitled,
  snapshotTaskNotesWriterEntitlements,
  type TaskNotesProofReportIdentity,
  type TaskNotesWriterEntitlement,
  type TaskNotesWriterSurface,
} from './task-notes-writer-entitlements.js';

function proofIdentity(
  writerTrain: TaskNotesWriterSurface,
  overrides: Partial<TaskNotesProofReportIdentity> = {},
): TaskNotesProofReportIdentity {
  return {
    artifactDigest: '1'.repeat(64),
    commandManifestDigest: '2'.repeat(64),
    dependencyEdgeDigest: '3'.repeat(64),
    fixtureSeedDigest: '4'.repeat(64),
    formatVersion: 1,
    proofDigest: '5'.repeat(64),
    relevantTreeDigest: '6'.repeat(64),
    sourceManifestDigest: '7'.repeat(64),
    toolchainDigest: '8'.repeat(64),
    writerTrain,
    ...overrides,
  };
}

describe('task-notes writer entitlements', () => {
  it('keeps both independently controlled surfaces dark by default', () => {
    const entitlements = createTaskNotesWriterEntitlements();

    expect(isTaskNotesWriterEntitled(entitlements.desktop, 'desktop')).toBe(false);
    expect(isTaskNotesWriterEntitled(entitlements.remote, 'remote')).toBe(false);
    expect(entitlements).toEqual({
      desktop: { proofReportIdentity: null, surface: 'desktop', write: false },
      remote: { proofReportIdentity: null, surface: 'remote', write: false },
    });
    expect(Object.isFrozen(entitlements)).toBe(true);
    expect(Object.isFrozen(entitlements.desktop)).toBe(true);
    expect(Object.isFrozen(entitlements.remote)).toBe(true);
  });

  it('enables only the surface with byte-equal report and promotion identities', () => {
    const desktop = proofIdentity('desktop');
    const entitlements = createTaskNotesWriterEntitlements({
      desktop: { promotionIdentity: { ...desktop }, reportIdentity: desktop },
    });

    expect(isTaskNotesWriterEntitled(entitlements.desktop, 'desktop')).toBe(true);
    expect(isTaskNotesWriterEntitled(entitlements.desktop, 'remote')).toBe(false);
    expect(isTaskNotesWriterEntitled(entitlements.remote, 'remote')).toBe(false);
    expect(entitlements.desktop.proofReportIdentity).toEqual(desktop);
  });

  it('denies malformed, cross-train, and mismatched proof identities independently', () => {
    const desktop = proofIdentity('desktop');
    const remote = proofIdentity('remote');
    const entitlements = createTaskNotesWriterEntitlements({
      desktop: {
        promotionIdentity: { ...desktop, artifactDigest: '9'.repeat(64) },
        reportIdentity: desktop,
      },
      remote: {
        promotionIdentity: remote,
        reportIdentity: { ...remote, writerTrain: 'desktop' },
      },
    });

    expect(isTaskNotesWriterEntitled(entitlements.desktop, 'desktop')).toBe(false);
    expect(isTaskNotesWriterEntitled(entitlements.remote, 'remote')).toBe(false);
    expect(
      createTaskNotesWriterEntitlements({
        desktop: {
          promotionIdentity: desktop,
          reportIdentity: { ...desktop, extra: true },
        },
      }).desktop.write,
    ).toBe(false);
  });

  it('rejects a structurally forged entitlement that was not issued by the owner', () => {
    const identity = proofIdentity('desktop');
    const forged = {
      proofReportIdentity: identity,
      surface: 'desktop',
      write: true,
    } as TaskNotesWriterEntitlement;

    expect(isTaskNotesWriterEntitled(forged, 'desktop')).toBe(false);
  });

  it('captures a frozen outer snapshot that ignores later source replacement', () => {
    const dark = createTaskNotesWriterEntitlements();
    const enabled = createTaskNotesWriterEntitlements({
      desktop: {
        promotionIdentity: proofIdentity('desktop'),
        reportIdentity: proofIdentity('desktop'),
      },
    });
    const source = { desktop: dark.desktop, remote: dark.remote };
    const snapshot = snapshotTaskNotesWriterEntitlements(source);

    source.desktop = enabled.desktop;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(isTaskNotesWriterEntitled(snapshot.desktop, 'desktop')).toBe(false);
    expect(isTaskNotesWriterEntitled(source.desktop, 'desktop')).toBe(true);
  });
});
