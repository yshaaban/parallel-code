import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listGitWorktrees } from './git-worktree.js';
import { isTaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import {
  createTaskCreationJournal,
  deriveTaskCreationConflictKey,
  type TaskCreationJournalRecord,
} from './task-creation-journal.js';
import {
  claimManagedWorktreeRecoveryQuarantine,
  getManagedWorktreeRecoveryQuarantinePath,
  inspectManagedWorktreeRecoveryQuarantine,
  releaseManagedWorktreeRecoveryBranch,
} from './task-worktree-removal.js';

let root = '';
let repo = '';
let worktreePath = '';

function git(args: readonly string[], cwd = repo): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function request(operationId = 'creation-operation-1') {
  return {
    branchName: 'task/one',
    operationId,
    projectRoot: repo,
    worktreePath,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-worktree-removal-'));
  repo = path.join(root, 'repo');
  worktreePath = path.join(repo, '.worktrees', 'task-one');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', 'task/one', worktreePath]);
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

describe('managed worktree removal quarantine', () => {
  it('retains dirty bytes, replays the exact claim, then releases only the proven branch OID', async () => {
    fs.writeFileSync(path.join(worktreePath, 'uncommitted.txt'), 'keep me\n');

    const first = await claimManagedWorktreeRecoveryQuarantine(request());
    const replay = await claimManagedWorktreeRecoveryQuarantine(request());

    expect(replay).toEqual(first);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.readFileSync(path.join(first.quarantineLocator, 'uncommitted.txt'), 'utf8')).toBe(
      'keep me\n',
    );
    expect(git(['show-ref', '--verify', '--hash', 'refs/heads/task/one'])).toBe(first.headOid);
    expect(await listGitWorktrees(repo)).toContainEqual(
      expect.objectContaining({
        branchName: null,
        detached: true,
        lockedReason: 'parallel-code-removal:creation-operation-1',
        path: fs.realpathSync(first.quarantineLocator),
      }),
    );

    await expect(releaseManagedWorktreeRecoveryBranch(request(), first)).resolves.toMatchObject({
      state: 'released',
    });
    await expect(releaseManagedWorktreeRecoveryBranch(request(), first)).resolves.toMatchObject({
      state: 'already-released',
    });
    expect(git(['for-each-ref', '--format=%(objectname)', 'refs/heads/task/one'])).toBe('');
    expect(fs.existsSync(first.quarantineLocator)).toBe(true);
  });

  it('persists its complete recovery identity through strict creation-journal validation', async () => {
    const retained = await claimManagedWorktreeRecoveryQuarantine(request());
    expect(retained.operationLockOwnershipWitness).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.byteLength(retained.operationLockResourceId, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(retained.recoveryId, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(retained.resourceId, 'utf8')).toBeLessThanOrEqual(64);

    const encodedOperationId = Buffer.alloc(16, 0x41).toString('base64url');
    if (!isTaskCreationOperationId(encodedOperationId)) {
      throw new Error('Test operation ID is not canonical');
    }
    const conflictKey = deriveTaskCreationConflictKey('managed-worktree', worktreePath);
    const record: TaskCreationJournalRecord = {
      activeConflictKeys: [conflictKey],
      capabilityHash: sha256('capability'),
      commit: { kind: 'not-committed' },
      conflictKeys: [conflictKey],
      createdAtMs: 100,
      formatVersion: 1,
      identities: {
        deliveryId: null,
        launchOperationId: 'launch-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      issueCode: 'manual-reconciliation-required',
      operationId: encodedOperationId,
      phase: 'manual-reconciliation-required',
      reconciliation: {
        branchDelete: { state: 'pending' },
        conflictKey,
        kind: 'retained-quarantine',
        operationLockOwnershipWitness: retained.operationLockOwnershipWitness,
        operationLockResourceId: retained.operationLockResourceId,
        quarantineLocator: retained.quarantineLocator,
        recoveryId: retained.recoveryId,
        resourceId: retained.resourceId,
        restore: { kind: 'retained' },
      },
      recordVersion: 1,
      retention: { kind: 'retained-artifact' },
      semanticFingerprint: sha256('semantic'),
      taskMode: 'terminal',
      updatedAtMs: 100,
      warning: { warningReservationBytes: 0 },
      workspacePrincipalHash: sha256('principal'),
    };
    const journalRoot = path.join(root, 'creation-journal');
    const journalEnv = { isPackaged: true, userDataPath: path.join(root, 'user-data') };
    const journal = createTaskCreationJournal(journalEnv, { rootPath: journalRoot });
    await journal.activateFresh();
    await journal.save(record, null);
    await journal.close();

    const restarted = createTaskCreationJournal(journalEnv, { rootPath: journalRoot });
    try {
      await restarted.startup();
      expect(restarted.getByOperationId(encodedOperationId)?.reconciliation).toMatchObject({
        kind: 'retained-quarantine',
        operationLockOwnershipWitness: retained.operationLockOwnershipWitness,
        operationLockResourceId: retained.operationLockResourceId,
        recoveryId: retained.recoveryId,
        resourceId: retained.resourceId,
      });
    } finally {
      await restarted.close();
    }
  });

  it('never replaces a pre-existing recovery target or moves the owned source', async () => {
    const quarantinePath = getManagedWorktreeRecoveryQuarantinePath(
      worktreePath,
      request().operationId,
    );
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.writeFileSync(path.join(quarantinePath, 'foreign.txt'), 'foreign\n');

    await expect(claimManagedWorktreeRecoveryQuarantine(request())).rejects.toThrow(
      'requires recovery',
    );
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(quarantinePath, 'foreign.txt'), 'utf8')).toBe('foreign\n');
    expect(git(['show-ref', '--verify', '--hash', 'refs/heads/task/one'])).not.toBe('');
  });

  it('classifies only the exact operation-owned quarantine tuple as present or absent', async () => {
    const retained = await claimManagedWorktreeRecoveryQuarantine(request());

    await expect(
      inspectManagedWorktreeRecoveryQuarantine(request(), retained),
    ).resolves.toMatchObject({ headOid: retained.headOid, kind: 'exact-present' });
    await expect(
      inspectManagedWorktreeRecoveryQuarantine(request('creation-operation-2'), retained),
    ).resolves.toEqual({ kind: 'proof-insufficient' });

    git(['worktree', 'unlock', retained.quarantineLocator]);
    git(['worktree', 'remove', '--force', retained.quarantineLocator]);
    await expect(inspectManagedWorktreeRecoveryQuarantine(request(), retained)).resolves.toEqual({
      kind: 'exact-absent',
    });
  });

  it('refuses branch release after the named ref moves to another OID', async () => {
    const retained = await claimManagedWorktreeRecoveryQuarantine(request());
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n');
    git(['add', 'second.txt']);
    git(['commit', '-m', 'second']);
    const changedOid = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/heads/task/one', changedOid]);

    await expect(releaseManagedWorktreeRecoveryBranch(request(), retained)).rejects.toThrow(
      'Owned branch changed',
    );
    expect(git(['show-ref', '--verify', '--hash', 'refs/heads/task/one'])).toBe(changedOid);
    expect(fs.existsSync(retained.quarantineLocator)).toBe(true);
  });

  it('rejects recovery evidence from another operation before any ref mutation', async () => {
    const retained = await claimManagedWorktreeRecoveryQuarantine(request());

    await expect(
      releaseManagedWorktreeRecoveryBranch(request('creation-operation-2'), retained),
    ).rejects.toThrow('does not match');
    expect(git(['show-ref', '--verify', '--hash', 'refs/heads/task/one'])).toBe(retained.headOid);
  });
});
