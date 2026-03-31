import crypto from 'crypto';
import path from 'path';

export interface TaskContainerIdentityInput {
  projectPath: string;
  taskId: string;
  worktreePath: string;
}

export interface TaskContainerIdentity {
  composeProjectName: string;
  ownershipLabels: Record<string, string>;
}

const COMPOSE_PROJECT_NAME_MAX_LENGTH = 55;

function slugifySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '');

  return normalized.length > 0 ? normalized : 'task';
}

function buildDeterministicHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
}

export function createTaskContainerIdentity(
  input: TaskContainerIdentityInput,
): TaskContainerIdentity {
  const projectSegment = slugifySegment(path.basename(input.projectPath));
  const taskSegment = slugifySegment(input.taskId);
  const hash = buildDeterministicHash(
    `${input.projectPath}\n${input.worktreePath}\n${input.taskId}`,
  );
  const prefix = `${projectSegment}-${taskSegment}`;
  const availablePrefixLength = Math.max(
    1,
    COMPOSE_PROJECT_NAME_MAX_LENGTH - `parallel-${hash}`.length - 1,
  );
  const trimmedPrefix = prefix.slice(0, availablePrefixLength).replace(/-+$/g, '') || 'task';
  const composeProjectName = `parallel-${trimmedPrefix}-${hash}`;

  return {
    composeProjectName,
    ownershipLabels: {
      'io.parallel-code.managed': 'true',
      'io.parallel-code.project-path-hash': buildDeterministicHash(input.projectPath),
      'io.parallel-code.task-id': input.taskId,
      'io.parallel-code.worktree-path-hash': buildDeterministicHash(input.worktreePath),
    },
  };
}
