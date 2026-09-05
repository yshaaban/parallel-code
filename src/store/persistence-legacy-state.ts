import type { AgentDef } from '../ipc/types.js';
import {
  isTaskCreationOperationLink,
  isTaskCreationProvenance,
  isTaskInitialShellOwnership,
} from '../domain/task-creation-provenance.js';
import { isTaskMode } from '../domain/task-mode.js';
import {
  isFiniteNumber,
  isNonNegativeInteger,
  isRecord,
  isStringArray,
} from '../lib/type-guards.js';
import type { CommittedMergeOperationMarker, MergeProgressSnapshot } from '../domain/task-merge.js';
import type { PersistedTask, PersistedWindowState, Project } from './types.js';

export type HydratablePersistedTask = Omit<
  PersistedTask,
  'agentDef' | 'projectId' | 'shellCount'
> & {
  agentDef?: AgentDef | null;
  projectId?: string;
  shellCount?: number;
};

export interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, unknown>;
  activeTaskId?: string | null;
  sidebarVisible?: boolean;
  fontScales?: unknown;
  panelSizes?: unknown;
  globalScale?: unknown;
  completedTaskDate?: unknown;
  completedTaskCount?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
  /** Backend-owned canonical projection; legacy metric fields above are compatibility mirrors. */
  mergeProgress?: MergeProgressSnapshot | unknown;
  committedMergeOperationId?: string | unknown;
  mergeOperation?: CommittedMergeOperationMarker | unknown;
  terminalFontSize?: unknown;
  terminalFont?: unknown;
  fontSmoothing?: unknown;
  themePreset?: unknown;
  windowState?: unknown;
  autoTrustFolders?: unknown;
  sidebarSectionCollapsed?: unknown;
  showPlans?: unknown;
  terminalHighLoadMode?: unknown;
  terminalLocalInputFeedbackEnabled?: unknown;
  taskNotificationsEnabled?: unknown;
  taskNotificationsPreferenceInitialized?: unknown;
  desktopNotificationsEnabled?: unknown;
  verboseLogging?: unknown;
  inactiveColumnOpacity?: unknown;
  hasSeenDesktopIntro?: unknown;
  editorCommand?: unknown;
  hydraCommand?: unknown;
  hydraForceDispatchFromPromptPanel?: unknown;
  hydraStartupMode?: unknown;
  keybindings?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalInitialPromptDeliveryMode(
  value: unknown,
): value is 'automatic' | 'manual-only' | undefined {
  return value === undefined || value === 'automatic' || value === 'manual-only';
}

function isOptionalProjectMode(value: unknown): value is 'git' | 'non-git' | undefined {
  return value === undefined || value === 'git' || value === 'non-git';
}

function isOptionalCoordinatorRole(value: unknown): value is 'coordinator' | 'subtask' | undefined {
  return value === undefined || value === 'coordinator' || value === 'subtask';
}

function isOptionalTaskTerminalLayoutMode(
  value: unknown,
): value is 'focused' | 'split' | 'grid' | 'stacked' | undefined {
  return (
    value === undefined ||
    value === 'focused' ||
    value === 'split' ||
    value === 'grid' ||
    value === 'stacked'
  );
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalPersistedAgentDefArray(value: unknown): value is AgentDef[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isPersistedAgentDef));
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

export function isPersistedAgentDef(value: unknown): value is AgentDef {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.command === 'string'
  );
}

export function isPersistedTask(value: unknown): value is HydratablePersistedTask {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    (value.taskMode === undefined || isTaskMode(value.taskMode)) &&
    typeof value.name === 'string' &&
    isOptionalString(value.projectId) &&
    typeof value.branchName === 'string' &&
    typeof value.worktreePath === 'string' &&
    typeof value.notes === 'string' &&
    typeof value.lastPrompt === 'string' &&
    (value.shellCount === undefined || isNonNegativeInteger(value.shellCount)) &&
    isOptionalStringOrNull(value.agentId) &&
    isOptionalStringArray(value.agentIds) &&
    isOptionalPersistedAgentDefArray(value.agentDefs) &&
    isOptionalString(value.selectedAgentId) &&
    isOptionalTaskTerminalLayoutMode(value.terminalLayoutMode) &&
    isOptionalStringArray(value.shellAgentIds) &&
    (value.agentDef === undefined ||
      value.agentDef === null ||
      isPersistedAgentDef(value.agentDef)) &&
    isOptionalString(value.baseBranch) &&
    isOptionalProjectMode(value.projectMode) &&
    isOptionalBoolean(value.directMode) &&
    isOptionalBoolean(value.skipPermissions) &&
    isOptionalString(value.githubUrl) &&
    isOptionalString(value.initialPrompt) &&
    isOptionalString(value.initialPromptDeliveryId) &&
    isOptionalInitialPromptDeliveryMode(value.initialPromptDeliveryMode) &&
    isOptionalString(value.savedInitialPrompt) &&
    (value.savedSelectedAgentIndex === undefined ||
      isNonNegativeInteger(value.savedSelectedAgentIndex)) &&
    isOptionalString(value.planFileName) &&
    isOptionalString(value.planRelativePath) &&
    isOptionalBoolean(value.stepsTracking) &&
    isOptionalString(value.coordinatorCredentialPath) &&
    isOptionalString(value.coordinatorParentTaskId) &&
    isOptionalCoordinatorRole(value.coordinatorRole) &&
    isOptionalString(value.coordinatorRunId) &&
    isOptionalString(value.coordinatorToolCommand) &&
    (value.taskCreationProvenance === undefined ||
      isTaskCreationProvenance(value.taskCreationProvenance)) &&
    (value.taskCreationOperationLink === undefined ||
      isTaskCreationOperationLink(value.taskCreationOperationLink)) &&
    (value.taskInitialShellOwnership === undefined ||
      isTaskInitialShellOwnership(value.taskInitialShellOwnership)) &&
    isOptionalBoolean(value.collapsed)
  );
}

export function parsePersistedWindowState(value: unknown): PersistedWindowState | null {
  if (!isRecord(value)) {
    return null;
  }

  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  const maximized = value.maximized;

  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    width <= 0 ||
    !isFiniteNumber(height) ||
    height <= 0 ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized,
  };
}

export function isLegacyPersistedState(raw: unknown): raw is LegacyPersistedState {
  return (
    isRecord(raw) &&
    isOptionalString(raw.projectRoot) &&
    isOptionalStringOrNull(raw.lastProjectId) &&
    isOptionalStringOrNull(raw.lastAgentId) &&
    isOptionalStringOrNull(raw.activeTaskId) &&
    isOptionalBoolean(raw.sidebarVisible) &&
    isStringArray(raw.taskOrder) &&
    (raw.collapsedTaskOrder === undefined || isStringArray(raw.collapsedTaskOrder)) &&
    isRecord(raw.tasks)
  );
}
