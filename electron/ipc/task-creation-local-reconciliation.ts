import { createHash } from 'node:crypto';

import type { TaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import type { TaskCreationJournal, TaskCreationJournalRecord } from './task-creation-journal.js';
import {
  createTaskCreationReconciliationService,
  type TaskCreationReconciliationAction,
  type TaskCreationReconciliationActionResult,
  type TaskCreationReconciliationDependencies,
} from './task-creation-reconciliation.js';

export const TASK_CREATION_RECONCILIATION_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 25;
const CURSOR_PATTERN = /^(\d{1,4})~([0-9a-f]{64})$/u;

export interface ListTaskCreationReconciliationsRequest {
  cursor?: string;
  limit?: number;
}

export type ListTaskCreationReconciliationsResult =
  | {
      items: TaskCreationOperationSnapshot[];
      kind: 'page';
      nextCursor: string | null;
    }
  | { kind: 'stale' };

/**
 * Actor-bound local command. Authority is captured by the composition root and
 * is never accepted from request data, headers, renderer IPC, or remote grants.
 */
export interface TaskCreationLocalReconciliationCommand {
  execute(
    action: TaskCreationReconciliationAction,
  ): Promise<TaskCreationReconciliationActionResult>;
  inspect(operationId: TaskCreationOperationId): Promise<TaskCreationReconciliationActionResult>;
  list(
    request?: Readonly<ListTaskCreationReconciliationsRequest>,
  ): Promise<ListTaskCreationReconciliationsResult>;
}

export interface TaskCreationLocalReconciliationCommands {
  electronMain: TaskCreationLocalReconciliationCommand;
  owningUserCli: TaskCreationLocalReconciliationCommand;
}

export interface CreateTaskCreationLocalReconciliationCommandsDependencies extends Omit<
  TaskCreationReconciliationDependencies,
  'authorizeLocalAdmin' | 'journal'
> {
  journal: TaskCreationJournal;
}

export function isListTaskCreationReconciliationsRequest(
  value: unknown,
): value is ListTaskCreationReconciliationsRequest | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.every((key) => key === 'cursor' || key === 'limit') &&
    (candidate.cursor === undefined || typeof candidate.cursor === 'string') &&
    (candidate.limit === undefined || typeof candidate.limit === 'number')
  );
}

function isReconciliationCandidate(record: Readonly<TaskCreationJournalRecord>): boolean {
  return (
    record.reconciliation.kind !== 'none' &&
    (record.phase === 'manual-reconciliation-required' || record.phase === 'failed-before-commit')
  );
}

function compareRecords(
  left: Readonly<TaskCreationJournalRecord>,
  right: Readonly<TaskCreationJournalRecord>,
): number {
  return right.updatedAtMs - left.updatedAtMs || left.operationId.localeCompare(right.operationId);
}

function candidateSetFingerprint(records: readonly TaskCreationJournalRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(record.operationId, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(record.recordVersion), 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function cursorFor(offset: number, fingerprint: string): string {
  return `${offset}~${fingerprint}`;
}

function parseCursor(cursor: string | undefined): { fingerprint: string; offset: number } | null {
  if (cursor === undefined) return null;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new Error('Invalid task-creation reconciliation cursor');
  const offset = Number(match[1]);
  const fingerprint = match[2];
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 4_096 || fingerprint === undefined) {
    throw new Error('Invalid task-creation reconciliation cursor');
  }
  return { fingerprint, offset };
}

function readLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > TASK_CREATION_RECONCILIATION_PAGE_LIMIT
  ) {
    throw new Error('Invalid task-creation reconciliation page limit');
  }
  return limit;
}

class TaskCreationLocalReconciliationCommandImpl implements TaskCreationLocalReconciliationCommand {
  constructor(
    private readonly authority: object,
    private readonly journal: TaskCreationJournal,
    private readonly service: ReturnType<typeof createTaskCreationReconciliationService>,
    private readonly buildSnapshot: TaskCreationReconciliationDependencies['buildSnapshot'],
  ) {}

  execute(
    action: TaskCreationReconciliationAction,
  ): Promise<TaskCreationReconciliationActionResult> {
    return this.service.execute(this.authority, action);
  }

  inspect(operationId: TaskCreationOperationId): Promise<TaskCreationReconciliationActionResult> {
    return this.execute({ kind: 'inspect', operationId });
  }

  async list(
    request: Readonly<ListTaskCreationReconciliationsRequest> = {},
  ): Promise<ListTaskCreationReconciliationsResult> {
    const limit = readLimit(request.limit);
    const cursor = parseCursor(request.cursor);
    const records = this.journal.list().filter(isReconciliationCandidate).sort(compareRecords);
    const fingerprint = candidateSetFingerprint(records);
    if (cursor && cursor.fingerprint !== fingerprint) return { kind: 'stale' };
    const pageStart = cursor?.offset ?? 0;
    if (pageStart > records.length) return { kind: 'stale' };
    const page = records.slice(pageStart, pageStart + limit);
    const items = await Promise.all(page.map((record) => this.buildSnapshot(record)));
    return {
      items,
      kind: 'page',
      nextCursor:
        page.length > 0 && pageStart + page.length < records.length
          ? cursorFor(pageStart + page.length, fingerprint)
          : null,
    };
  }
}

/**
 * Creates one reconciliation service and two actor-bound local views. The
 * identity tokens stay inside this closure, so a caller cannot forge local
 * authority by copying an actor label into request data.
 */
export function createTaskCreationLocalReconciliationCommands(
  dependencies: CreateTaskCreationLocalReconciliationCommandsDependencies,
): TaskCreationLocalReconciliationCommands {
  const electronMainAuthority = Object.freeze({});
  const owningUserCliAuthority = Object.freeze({});
  const service = createTaskCreationReconciliationService({
    ...dependencies,
    authorizeLocalAdmin: (authority) =>
      authority === electronMainAuthority
        ? 'electron-main'
        : authority === owningUserCliAuthority
          ? 'owning-user-cli'
          : null,
  });
  const createCommand = (authority: object): TaskCreationLocalReconciliationCommand =>
    new TaskCreationLocalReconciliationCommandImpl(
      authority,
      dependencies.journal,
      service,
      dependencies.buildSnapshot,
    );
  return Object.freeze({
    electronMain: createCommand(electronMainAuthority),
    owningUserCli: createCommand(owningUserCliAuthority),
  });
}
