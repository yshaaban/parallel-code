import type { PersistedTask, PersistedWindowState, Project } from './types';

export interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  fontScales?: unknown;
  panelSizes?: unknown;
  globalScale?: unknown;
  completedTaskDate?: unknown;
  completedTaskCount?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
  terminalFont?: unknown;
  themePreset?: unknown;
  windowState?: unknown;
  autoTrustFolders?: unknown;
  showPlans?: unknown;
  inactiveColumnOpacity?: unknown;
  hasSeenDesktopIntro?: unknown;
  editorCommand?: unknown;
  hydraCommand?: unknown;
  hydraForceDispatchFromPromptPanel?: unknown;
  hydraStartupMode?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
}

export function parsePersistedWindowState(value: unknown): PersistedWindowState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const x = raw.x;
  const y = raw.y;
  const width = raw.width;
  const height = raw.height;
  const maximized = raw.maximized;

  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
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
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as LegacyPersistedState).taskOrder) &&
    typeof (raw as LegacyPersistedState).tasks === 'object'
  );
}
