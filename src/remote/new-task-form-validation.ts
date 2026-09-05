import {
  TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES,
  TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES,
  TASK_CREATION_NAME_MAX_UTF8_BYTES,
  type TaskCreationCapabilities,
} from '../domain/task-creation';
import { TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES } from '../domain/task-initial-prompt-delivery';
import type { RemoteProjectSummary, RemoteTaskLocationKind } from '../domain/task-catalog';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar';

const textEncoder = new TextEncoder();
const CONTROL_CHARACTERS = /\p{Cc}/u;

export type RemoteNewTaskFormField =
  | 'agent'
  | 'branchPrefix'
  | 'existingWorktree'
  | 'githubUrl'
  | 'location'
  | 'name'
  | 'project'
  | 'prompt'
  | 'taskMode';

export type RemoteNewTaskFormErrors = Partial<Record<RemoteNewTaskFormField, string>>;

export interface RemoteNewTaskDraftValidationInput {
  agentAvailable: boolean;
  branchPrefixPreference: string;
  capabilities: TaskCreationCapabilities;
  existingWorktreeRef: string;
  githubUrl: string;
  initialPrompt: string;
  location: RemoteTaskLocationKind;
  name: string;
  project: RemoteProjectSummary | null;
  taskMode: 'agent' | 'terminal';
}

export function isRemoteTaskCreationCapabilityEnabled(
  globalCapability: { enabled: boolean },
  projectCapability?: { enabled: boolean },
): boolean {
  return globalCapability.enabled && (projectCapability?.enabled ?? true);
}

function getBoundedTextError(value: string, label: string, maxUtf8Bytes: number): string | null {
  if (!isWellFormedUnicodeScalarString(value) || CONTROL_CHARACTERS.test(value)) {
    return `${label} contains unsupported characters.`;
  }
  if (textEncoder.encode(value).byteLength > maxUtf8Bytes) {
    return `${label} must be at most ${maxUtf8Bytes.toLocaleString()} UTF-8 bytes.`;
  }
  return null;
}

function getPromptError(value: string): string | null {
  if (!isWellFormedUnicodeScalarString(value)) {
    return 'Initial prompt contains unsupported characters.';
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
    ) {
      return 'Initial prompt contains unsupported characters.';
    }
  }
  return textEncoder.encode(value).byteLength > TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES
    ? `Initial prompt must be at most ${TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES.toLocaleString()} UTF-8 bytes.`
    : null;
}

export function validateRemoteNewTaskDraft(
  input: RemoteNewTaskDraftValidationInput,
): RemoteNewTaskFormErrors {
  const errors: RemoteNewTaskFormErrors = {};
  if (!input.project) errors.project = 'Choose a project.';

  const normalizedName = input.name.trim();
  if (!normalizedName) {
    errors.name = 'Enter a task name.';
  } else {
    const nameError = getBoundedTextError(
      normalizedName,
      'Task name',
      TASK_CREATION_NAME_MAX_UTF8_BYTES,
    );
    if (nameError) errors.name = nameError;
  }

  if (!input.capabilities.modes[input.taskMode].enabled) {
    errors.taskMode = 'This task mode is unavailable.';
  }
  if (input.taskMode === 'agent') {
    if (!input.agentAvailable) errors.agent = 'Choose a supported agent.';
    const promptError = getPromptError(input.initialPrompt);
    if (promptError) errors.prompt = promptError;
  }

  if (
    input.project &&
    !isRemoteTaskCreationCapabilityEnabled(
      input.capabilities.locations[input.location],
      input.project.locations[input.location],
    )
  ) {
    errors.location = 'This location is unavailable for the selected project.';
  }
  if (input.location === 'existing-worktree' && !input.existingWorktreeRef) {
    errors.existingWorktree = 'Choose an imported worktree.';
  }

  const normalizedBranchPrefix = input.branchPrefixPreference.trim();
  if (input.location === 'managed-worktree' && normalizedBranchPrefix) {
    const branchPrefixError = getBoundedTextError(
      normalizedBranchPrefix,
      'Branch prefix',
      TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES,
    );
    if (branchPrefixError) errors.branchPrefix = branchPrefixError;
  }
  const normalizedGithubUrl = input.githubUrl.trim();
  if (normalizedGithubUrl) {
    const githubUrlError = getBoundedTextError(
      normalizedGithubUrl,
      'GitHub URL',
      TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES,
    );
    if (githubUrlError) errors.githubUrl = githubUrlError;
  }
  return errors;
}
